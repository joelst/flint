<script lang="ts">
  // @ts-nocheck  // runes ($state etc.) are handled by Svelte compiler, not raw TS
  import { onMount } from "svelte";
  import MessageRenderer from "$lib/MessageRenderer.svelte";
  import ConversationSidebar from "$lib/ConversationSidebar.svelte";
  import Icon from "$lib/Icon.svelte";
  import type { Conversation } from "$lib/ConversationSidebar.svelte";
  import {
    initializeSDK,
    getSDKState,
    getEps,
    refreshModels,
    ensureAccelerators,
    getRecommendedStarterModels,
    getSTTModels,
    startService,
    stopService,
    downloadModel,
    loadModel as sdkLoadModel,
    unloadModel as sdkUnloadModel,
    deleteModel as sdkDeleteModel,
    chatCompletion,
    chatCompletionStream,
    cancelChatRequest,
    transcribeAudio,
    appendAppLog,
    getAccessLog,
    pollPoolStatus,
    type ModelInfo,
    type EpInfo,
    type LogEntry,
  } from "$lib/sdk";

  import {
    PREDEFINED_PERSONAS,
    loadCustomPersonas,
    saveCustomPersonas,
    getAllPersonas,
    scorePersonaForModel,
    getModelTags,
    type Persona,
  } from "$lib/personas";

  import {
    integrations,
    renderSnippet,
    detectPlatform,
    type Integration,
    type IntegrationStatus,
  } from "$lib/integrations";

  import { enable as autostartEnable, disable as autostartDisable, isEnabled as autostartIsEnabled } from '$lib/autostart';

  // Integrations tab state
  let integrationsOS = $state<'windows' | 'unix'>(detectPlatform());
  let expandedIntegrationId = $state<string | null>(null);
  let copiedSnippetKey = $state<string | null>(null);

  function copyIntegrationSnippet(key: string, body: string) {
    navigator.clipboard?.writeText(body);
    copiedSnippetKey = key;
    setTimeout(() => {
      if (copiedSnippetKey === key) copiedSnippetKey = null;
    }, 1500);
  }

  function statusBadgeLabel(status: IntegrationStatus): string {
    if (status === 'verified') return 'Verified';
    if (status === 'community') return 'Community-reported';
    if (status === 'research-needed') return 'Unverified';
    return 'Not supported';
  }

  // Simple client-side navigation
  type View = "models" | "chat" | "audio" | "monitor" | "diagnostics" | "integrations" | "learn" | "settings" | "compare";
  let currentView = $state<View>("models");

  // Model capability helpers (based on catalog task/capabilities/family/alias)
  function modelSupportsChat(m: any): boolean {
    if (!m) return false;
    const alias = String(m.alias || '').toLowerCase();
    let task = '';
    let caps = '';
    const info = m.info || m;
    if (info) {
      task = String(info.task || '').toLowerCase();
      caps = String(info.capabilities || '').toLowerCase();
    }
    if (task.includes('automatic-speech-recognition') || task.includes('stt') || caps.includes('automatic-speech-recognition')) return false;
    if (alias.includes('whisper') || alias.includes('-stt') || alias.includes('stt-')) return false;
    if (task.includes('embedding') || alias.includes('embed')) return false;
    return true;
  }

  function detectHostPlatform(): "windows" | "macos" | "linux" | "unknown" {
    const platformRaw =
      String((navigator as any)?.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
    if (platformRaw.includes("mac")) return "macos";
    if (platformRaw.includes("win")) return "windows";
    if (platformRaw.includes("linux")) return "linux";
    return "unknown";
  }

  function classifyExecutionProvider(epName: string): "cpu" | "gpu" | "npu" | "other" {
    const n = String(epName || "").toLowerCase();
    if (n.includes("cpu")) return "cpu";
    if (n.includes("qnn") || n.includes("npu")) return "npu";
    if (
      n.includes("cuda") ||
      n.includes("directml") ||
      n.includes("dml") ||
      n.includes("coreml") ||
      n.includes("metal") ||
      n.includes("gpu")
    ) {
      return "gpu";
    }
    return "other";
  }

  function parseModelSizeMb(model: any): number | null {
    const direct = Number(
      model?.info?.fileSizeMb ??
      model?.info?.size ??
      model?.size ??
      model?.info?.info?.fileSizeMb ??
      0,
    );
    if (Number.isFinite(direct) && direct > 0) return direct;
    const raw = String(model?.size || model?.info?.size || "").trim().toLowerCase();
    if (!raw) return null;
    const match = raw.match(/([\d.]+)\s*(kb|mb|gb|tb)/);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || value <= 0) return null;
    if (unit === "kb") return value / 1024;
    if (unit === "mb") return value;
    if (unit === "gb") return value * 1024;
    if (unit === "tb") return value * 1024 * 1024;
    return null;
  }

  function formatSizeLabel(model: any): string {
    const sizeMb = parseModelSizeMb(model);
    if (!sizeMb) return "Unknown";
    if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`;
    return `${Math.round(sizeMb)} MB`;
  }

  function estimateMemoryRequirement(model: any): string {
    const sizeMb = parseModelSizeMb(model);
    if (!sizeMb) return "Unknown";
    // Approximate runtime footprint for local inference (weights + kv/cache/overhead).
    const lowGb = (sizeMb * 1.25) / 1024;
    const highGb = (sizeMb * 2.0) / 1024;
    if (highGb < 1) return `${Math.max(256, Math.round(lowGb * 1024))}-${Math.round(highGb * 1024)} MB`;
    return `${lowGb.toFixed(1)}-${highGb.toFixed(1)} GB`;
  }

  function formatContextLength(model: any): string {
    const info = model?.info || {};
    const value = info.contextLength ?? info.maxContext ?? null;
    return typeof value === "number" && value > 0 ? `${value} tokens (~${Math.round(value / 1024)}k)` : "Unknown";
  }

  function normalizeCapabilities(model: any): string[] {
    const raw = String(model?.info?.capabilities || model?.capabilities || "").trim();
    if (!raw) return [];
    return raw
      .split(/[,\n|]/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  function getShortModelDescription(model: any): string {
    const info = model?.info || {};
    const explicit = String(info.description || info.summary || "").trim();
    if (explicit) {
      return explicit.length > 140 ? `${explicit.slice(0, 137)}...` : explicit;
    }
    const task = String(info.task || "general-purpose");
    const caps = normalizeCapabilities(model);
    if (caps.length) return `${task} model with ${caps.slice(0, 2).join(" + ")} support.`;
    return `${task} model for local inference.`;
  }

  function getFamilyLabel(model: any): string | null {
    const family = String(model?.info?.family || model?.family || "").trim();
    return family || null;
  }

  function formatMetaTimestamp(value?: string): string {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString();
  }

  function getApplicableAccelerationLabels(
    model: any,
    eps: EpInfo[],
    platform: "windows" | "macos" | "linux" | "unknown",
  ): string[] {
    const labels: string[] = [];
    const has = { cpu: false, gpu: false, npu: false };
    for (const ep of eps || []) {
      if (!ep.isRegistered) continue;
      const kind = classifyExecutionProvider(ep.name);
      if (kind === "cpu" && !has.cpu) {
        labels.push("CPU");
        has.cpu = true;
      }
      if (kind === "gpu" && !has.gpu) {
        labels.push(platform === "macos" ? "Apple GPU (CoreML/Metal)" : "GPU");
        has.gpu = true;
      }
      if (kind === "npu" && !has.npu) {
        labels.push("NPU");
        has.npu = true;
      }
    }

    if (!has.cpu) labels.push("CPU");
    if (platform === "macos" && !has.gpu) labels.push("Apple GPU (CoreML/Metal)");
    if (platform === "windows" && !has.gpu) labels.push("GPU (DirectML if installed)");
    if (platform === "windows" && !has.npu) labels.push("NPU (QNN if installed)");
    if (platform === "linux" && !has.gpu) labels.push("GPU (CUDA/ROCm if installed)");

    const sizeMb = parseModelSizeMb(model);
    if (sizeMb && sizeMb > 10_000 && !labels.some((l) => l.includes("GPU"))) {
      labels.push("GPU recommended for this size");
    }
    return [...new Set(labels)];
  }

  function describeAccelerationFit(model: any, preference: string): string {
    if (preference === "auto") {
      return "Auto mode: runtime will choose the best available execution provider.";
    }
    const kind = classifyExecutionProvider(preference);
    const sizeMb = parseModelSizeMb(model) ?? 0;
    if (kind === "npu") {
      return sizeMb > 7000
        ? "Large model for NPU-only workflows; expect slower startup or fallback."
        : "Good candidate for NPU acceleration if the runtime supports this model/provider pair.";
    }
    if (kind === "gpu") {
      return "Good candidate for GPU acceleration when compatible kernels are available.";
    }
    if (kind === "cpu") {
      return "Will run on CPU; lower memory pressure but generally slower generation throughput.";
    }
    return "Provider selected. Runtime compatibility depends on model format and installed kernels.";
  }

  async function refreshExecutionProviders() {
    if (!state.ready) return;
    try {
      await getEps();
      statusMessage = `${state.eps.length} execution providers detected`;
      await loadRecommendations();
    } catch (e: any) {
      statusMessage = `Provider check failed: ${e?.message || e}`;
    }
  }

  async function setAccelerationPreference(nextPreference: string) {
    selectedAccelerationPreference = nextPreference || "auto";
    persistChat();
    statusMessage =
      selectedAccelerationPreference === "auto"
        ? "Acceleration preference set to Auto (runtime chooses)."
        : `Acceleration preference set to ${selectedAccelerationPreference}.`;
    await loadRecommendations();
  }

  function modelSupportsAudio(m: any): boolean {
    if (!m) return false;
    const alias = String(m.alias || '').toLowerCase();
    let task = '';
    let caps = '';
    const info = m.info || m;
    if (info) {
      task = String(info.task || '').toLowerCase();
      caps = String(info.capabilities || '').toLowerCase();
    }
    return task.includes('automatic-speech-recognition') || task.includes('stt') || caps.includes('automatic-speech-recognition') || alias.includes('whisper');
  }

  const sdkStateStore = getSDKState();

  // Local UI state (runes)
  let isLoadingModels = $state(false);
  let searchTerm = $state("");
  let statusMessage = $state("");

  // Mirror of SDK store for easy template access
  let state = $state({
    ready: false,
    error: null as string | null,
    models: [] as ModelInfo[],
    endpoint: undefined as string | undefined,
    eps: [] as EpInfo[],
    acceleratorsReady: false,
    serviceRunning: false,
    pool: [] as any[],
    poolStats: null as any,
  });

  // Recommended starters
  let recommendedStarters = $state([] as ModelInfo[]);
  let isLoadingRecommendations = $state(false);
  let selectedAccelerationPreference = $state<string>("auto");
  let hostPlatform = $state<"windows" | "macos" | "linux" | "unknown">("unknown");
  let isMac = $derived(hostPlatform === 'macos');
  const isDev = import.meta.env.DEV;
  let modelDetailsAlias = $state<string | null>(null);
  let modelRuntimeMeta = $state<Record<string, { downloadedAt?: string; lastUsedAcceleration?: string }>>({});
  let variantPanelOpen = $state<Record<string, boolean>>({});
  let startupModels = $state<Record<string, string | null>>({});
  let downloadingModelAliases = $state<Record<string, boolean>>({});
  let downloadingVariantIds = $state<Record<string, boolean>>({});
  let monitorLog = $state<any[]>([]);
  let monitorLogPaused = $state(false);

  // Compare (bake-off) state - simple side-by-side for 0.3
  let compareSelected: string[] = $state([]);
  let comparePrompt = $state("");
  let compareResults: Record<string, { content: string; latencyMs?: number; tokensIn?: number; tokensOut?: number; rating?: 'up'|'down' | null }> = $state({});
  let isComparing = $state(false);

  // Settings: startup behaviour
  let autoStartService = $state(true);
  let defaultChatAlias = $state('');
  let defaultAudioAlias = $state('');
  let osAutoStartEnabled = $state<boolean | null>(null);

  // Settings: network
  let networkPort = $state(5272);
  let networkBindAddress = $state('127.0.0.1');

  // UI: keyboard shortcut help modal
  let showShortcutsHelp = $state(false);

  // Chat state
  let selectedModelAlias = $state("");
  let selectedModel: any = $state(null);
  let chatClient: any = $state(null);
  let chatMessages = $state<any[]>([]);
  let chatInput = $state("");
  let isStreaming = $state(false);
  let systemPrompt = $state("You are a helpful assistant.");

  // Context management (important for local models - controls token usage)
  // We keep *all* messages for display/history, but only send a sliding window to the model.
  let contextTurns = $state(12); // number of recent turns (user+assistant pairs) to include

  // Whether to show the complete uncondensed thread (for reading full history)
  let showFullHistory = $state(false);

  // Collapsible left sidebar
  let sidebarCollapsed = $state(false);

  // Theme: light or dark
  let theme = $state<'light' | 'dark'>('dark');

  let abortController: AbortController | null = $state(null);
  let activeStreamRequestId: number | null = $state(null);
  let attachedImages: string[] = $state([]); // array of base64 data urls for vision

  // Proper vision capability detection based on model metadata (not just alias name).
  // We gate multi-image UI on the *selected* model being vision-capable.
  // This follows the sprint plan: "only show attach controls when the selected model has vision capability".
  // We do NOT require the model to already be "loaded" in the pool — attaching images
  // is allowed for vision models; the send path will ensure it's loaded via the pool.
  let isVisionModel = $derived.by(() => {
    if (!selectedModelAlias) return false;
    const model = state.models.find((m: any) => m.alias === selectedModelAlias);
    if (!model) return false;
    const tags = getModelTags(selectedModelAlias, model.info);
    return tags.includes('vision');
  });

  // Auto-clear images if user switches away from a vision model
  $effect(() => {
    if (!isVisionModel && attachedImages.length > 0) {
      attachedImages = [];
    }
  });

  // Personas (system prompt presets)
  let customPersonas = $state<Persona[]>([]);
  let showPersonaMenu = $state(false);
  let showPersonaManager = $state(false);
  let managerNewName = $state("");
  let managerNewPrompt = $state("");
  let editingPersona: Persona | null = $state(null);

  // For positioning the persona dropdown (fixed to escape scrollers)
  let personaBtnEl: HTMLButtonElement | null = $state(null);
  let personaMenuPos = $state({ top: 0, left: 0 });
  let personaMenuDirection = $state<'up' | 'down'>('down');

  // Derived list + current model context for recommendations
  const allPersonas = $derived(getAllPersonas(customPersonas));
  let currentModelTags = $derived(
    selectedModelAlias
      ? getModelTags(selectedModelAlias, state.models.find((m) => m.alias === selectedModelAlias)?.info)
      : ["general"]
  );

  // Sorted personas: highest match score first, then predefined/custom order
  const sortedPersonasForUI = $derived(
    [...allPersonas].sort((a, b) => {
      const sa = scorePersonaForModel(a, currentModelTags);
      const sb = scorePersonaForModel(b, currentModelTags);
      if (sb !== sa) return sb - sa;
      const ia = PREDEFINED_PERSONAS.findIndex((p) => p.id === a.id);
      const ib = PREDEFINED_PERSONAS.findIndex((p) => p.id === b.id);
      return ia - ib;
    })
  );

  const currentPersonaName = $derived(
    allPersonas.find((p) => p.prompt.trim() === systemPrompt.trim())?.name || ""
  );

  // Live context for inference (trimmed)
  const inferenceMessages = $derived(getMessagesForInference());
  const estimatedContextTokens = $derived(estimateTokensForMessages(inferenceMessages));

  const contextUsagePercent: number | null = $derived.by(() => {
    if (!currentModelContextLength || estimatedContextTokens <= 0) return null;
    return Math.min(100, Math.round((estimatedContextTokens / currentModelContextLength) * 100));
  });

  // === Step 1: Real context length from model metadata ===
  const currentModelInfo = $derived(
    state.models.find((m: ModelInfo) => m.alias === selectedModelAlias)?.info || null
  );
  const currentModelContextLength: number | null = $derived(
    currentModelInfo?.contextLength ?? currentModelInfo?.maxContext ?? null
  );
  const currentModelFamily: string | null = $derived(currentModelInfo?.family ?? null);

  // Rough recommended turns based on context length (very conservative)
  const recommendedMaxTurns: number = $derived.by(() => {
    if (!currentModelContextLength) return 12;
    // Very rough: assume ~250-350 tokens per turn (user + assistant avg)
    const estTokensPerTurn = 300;
    const safeBudget = Math.floor(currentModelContextLength * 0.6); // leave headroom for system + generation
    return Math.max(4, Math.min(40, Math.floor(safeBudget / estTokensPerTurn)));
  });

  // === Step 4: Per-model defaults ===
  // When model changes, optionally suggest or apply a good default
  $effect(() => {
    if (!selectedModelAlias || !currentModelContextLength) return;

    // Only auto-apply reasonable default if user hasn't manually set a very high value
    // or on first selection for this chat
    const sensible = recommendedMaxTurns;
    if (sensible && contextTurns > sensible * 1.5) {
      // User had a high value from a previous larger model — don't aggressively lower it
    } else if (contextTurns !== sensible && Math.abs(contextTurns - sensible) > 2) {
      // Gently sync to recommended (only if quite different)
      // We keep this conservative: user can override with the dropdown
    }
  });

  // === Auto-summary on threshold (yellow/red area) ===
  // Trigger automatically when context usage enters the yellow-to-red zone (>= 75%)
  let lastAutoSummaryCount = 0;
  $effect(() => {
    const percent = contextUsagePercent;
    if (!percent || isStreaming || !state.ready) return;
    if (percent < 75) return;  // yellow/red threshold

    const currentLen = chatMessages.length;
    // Avoid repeating too soon
    if (currentLen - lastAutoSummaryCount < 6) return;

    const hasRecentSummary = chatMessages.slice(-8).some((m: any) => m.isSummary);
    if (hasRecentSummary) return;

    // Auto compact (preserves the full original thread)
    lastAutoSummaryCount = currentLen;
    statusMessage = "Context usage high — auto-summarizing older turns...";
    compactConversationWithSummary(Math.max(4, Math.floor(contextTurns / 2)))
      .catch(() => {})
      .finally(() => {
        if (statusMessage.includes('auto-summarizing')) {
          statusMessage = "Auto-compacted. Toggle 'Full thread' to read everything.";
        }
      });
  });

  function applyRecommendedContext() {
    if (recommendedMaxTurns) {
      contextTurns = recommendedMaxTurns;
      statusMessage = `Context set to recommended ${recommendedMaxTurns} turns for this model`;
    }
  }

  // Close persona menu when clicking elsewhere
  $effect(() => {
    if (!showPersonaMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".persona-control")) {
        showPersonaMenu = false;
      }
    };
    document.addEventListener("click", handler, { capture: true });
    return () => document.removeEventListener("click", handler, { capture: true });
  });

  // Position persona menu (fixed) when opened, and close on scrolls to avoid stale positions vs scrollbars
  $effect(() => {
    if (!showPersonaMenu) return;

    queueMicrotask(positionPersonaMenu);

    const closeOnScroll = (e: Event) => {
      // Don't close when scrolling inside the menu's own item list
      if ((e.target as HTMLElement)?.closest?.('.persona-menu')) return;
      showPersonaMenu = false;
    };
    const repositionOnResize = () => {
      positionPersonaMenu();
    };

    // Capture phase to catch scrolling inside any child scroll containers (messages, content, etc.)
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", repositionOnResize);

    return () => {
      document.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", repositionOnResize);
    };
  });

  let messagesContainer = $state<HTMLDivElement | null>(null);

  // Audio state
  let isRecording = $state(false);
  let audioBlob = $state<Blob | null>(null);
  let transcription = $state("");
  let isTranscribing = $state(false);
  let transcriptionProgress = $state<{ current: number; total: number } | null>(null);
  let transcriptionLanguage = $state("auto");
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];

  // Dictation state (push-to-talk into chat input)
  let isDictating = $state(false);
  let dictationInterim = $state('');
  let dictationChunks: Blob[] = [];
  let dictationMediaRecorder: MediaRecorder | null = null;
  let dictationStream: MediaStream | null = null;
  let isRollingTranscribe = false;
  let sttModels = $state<ModelInfo[]>([]);
  let selectedSTTModelAlias = $state("");
  // Tracks the alias of a model explicitly loaded into the audio lane via
  // useSTTModelForAudio(). Used to prevent audio-lane loads from blocking chat.
  let audioLaneModelAlias = $state("");

  const selectedChatModel = $derived(state.models.find((m: any) => m.alias === selectedModelAlias));
  const selectedModelSupportsChat = $derived(
    !selectedModelAlias || (selectedChatModel ? modelSupportsChat(selectedChatModel) : true)
  );

  // If an STT model was loaded via the main UI / top bar / Models list,
  // the Audio page should inherit it automatically as the current STT model.
  const loadedAudioModel = $derived(
    state.models.find((m: any) => m.isLoaded && modelSupportsAudio(m))
  );

  // Prioritize the actually loaded STT model (so loading from top bar / Models
  // list / main UI immediately makes the Audio page inherit it).
  // Fall back to the last explicitly chosen STT (for when a chat model is
  // currently active, user can still "Ensure service" to bring their audio model back).
  const effectiveSTTModelAlias = $derived(
    loadedAudioModel?.alias || selectedSTTModelAlias || ""
  );
  // Chat is blocked only when an audio-capable model is loaded in the chat lane
  // (i.e. it was not deliberately loaded via useSTTModelForAudio into the audio lane)
  // AND no chat-capable model is also loaded and selected.
  const chatBlockedByLoadedSTT = $derived(
    !!loadedAudioModel &&
    (!selectedModelAlias || loadedAudioModel.alias !== selectedModelAlias) &&
    loadedAudioModel.alias !== audioLaneModelAlias &&
    !state.models.some((m: any) => m.isLoaded && modelSupportsChat(m) && m.alias === selectedModelAlias)
  );

  // Keep selectedSTTModelAlias in sync with the loaded audio model so that
  // "Current STT model" in the Audio page reflects loads done elsewhere
  // (top bar, Models tab "Load", etc.) and so it gets persisted.
  // Also clear audioLaneModelAlias when the audio-lane model is no longer loaded.
  $effect(() => {
    if (loadedAudioModel?.alias && selectedSTTModelAlias !== loadedAudioModel.alias) {
      selectedSTTModelAlias = loadedAudioModel.alias;
    }
    if (audioLaneModelAlias && loadedAudioModel?.alias !== audioLaneModelAlias) {
      audioLaneModelAlias = '';
    }
  });

  let sidecarLogs = $state<LogEntry[]>([]);
  let logListEl = $state<HTMLDivElement | null>(null);

  function autoScrollLog(node: HTMLElement) {
    const observer = new MutationObserver(() => {
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(node, { childList: true });
    return { destroy() { observer.disconnect(); } };
  }

  // Conversation management
  let conversations = $state<Conversation[]>([]);
  let currentConversationId = $state<string | null>(null);
  const CHATS_PERSIST_KEY = "flint-chats-v1";

  function generateConversationId(): string {
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function generateConversationTitle(): string {
    const firstMsg =
      chatMessages.find((m: any) => m.role === "user")?.content || "New chat";
    return firstMsg.substring(0, 50).trim() + (firstMsg.length > 50 ? "…" : "");
  }

  function createNewConversation() {
    const id = generateConversationId();
    currentConversationId = id;
    chatMessages = [];
    chatInput = "";
    lastAutoSummaryCount = 0;
    clearImages(); // clear any pending vision attachments for new chat
    conversations = [
      ...conversations,
      { id, title: "New chat", createdAt: Date.now(), messageCount: 0 },
    ];
    saveConversations();
  }

  function selectConversation(id: string) {
    if (currentConversationId === id) return;
    saveConversations();
    currentConversationId = id;
    chatMessages = [];
    chatInput = "";
  }

  function deleteConversation(id: string) {
    conversations = conversations.filter((c) => c.id !== id);
    if (currentConversationId === id) {
      if (conversations.length > 0) {
        selectConversation(conversations[0].id);
      } else {
        createNewConversation();
      }
    }
    saveConversations();
  }

  function saveConversations() {
    if (currentConversationId) {
      const conv = conversations.find((c) => c.id === currentConversationId);
      if (conv) {
        conv.title = generateConversationTitle();
        conv.messageCount = chatMessages.length;
      }
    }
    localStorage.setItem(CHATS_PERSIST_KEY, JSON.stringify(conversations));
  }

  function loadConversations() {
    try {
      const stored = localStorage.getItem(CHATS_PERSIST_KEY);
      if (stored) {
        conversations = JSON.parse(stored);
        if (conversations.length > 0) {
          currentConversationId = conversations[0].id;
        }
      }
    } catch (e) {
      console.warn("Failed to load conversations:", e);
    }
    if (!currentConversationId) {
      createNewConversation();
    }
  }

  function loadCustomPersonasState() {
    customPersonas = loadCustomPersonas();
  }

  function saveCustomPersonasState() {
    saveCustomPersonas(customPersonas);
  }

  function choosePersona(p: Persona) {
    systemPrompt = p.prompt;
    statusMessage = `Persona set: ${p.name}`;
  }

  function openPersonaManager() {
    editingPersona = null;
    managerNewName = "";
    managerNewPrompt = "";
    showPersonaManager = true;
    showPersonaMenu = false;
  }

  function closePersonaManager() {
    showPersonaManager = false;
    editingPersona = null;
    managerNewName = "";
    managerNewPrompt = "";
  }

  function positionPersonaMenu() {
    if (!personaBtnEl) return;
    const rect = personaBtnEl.getBoundingClientRect();
    const gap = 4;
    const maxH = 340;
    const menuMinW = 260;

    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const openUp = spaceBelow < maxH && rect.top > 160;
    personaMenuDirection = openUp ? 'up' : 'down';

    let left = rect.left;

    // Avoid going off the right edge of the window
    const rightEdge = window.innerWidth - 12;
    if (left + menuMinW > rightEdge) {
      left = Math.max(8, rightEdge - menuMinW);
    }

    if (openUp) {
      // Position so that after translateY(-100%) the menu bottom sits above button
      personaMenuPos = { top: rect.top - gap, left };
    } else {
      personaMenuPos = { top: rect.bottom + gap, left };
    }
  }

  function startEditPersona(p: Persona) {
    // Only custom or allow editing prompt for any? For simplicity allow editing any as custom copy
    editingPersona = { ...p };
    managerNewName = p.name;
    managerNewPrompt = p.prompt;
  }

  function saveEditedPersona() {
    if (!managerNewName.trim() || !managerNewPrompt.trim()) return;

    const newP: Persona = {
      id: editingPersona?.id || `custom-${Date.now()}`,
      name: managerNewName.trim(),
      prompt: managerNewPrompt.trim(),
      description: editingPersona?.description || "Custom persona",
      tags: editingPersona?.tags || ["general"],
    };

    // If it was a predefined id we create a new custom with new id
    const isPredefined = PREDEFINED_PERSONAS.some((pp) => pp.id === newP.id);
    if (isPredefined) {
      newP.id = `custom-${Date.now()}`;
      newP.description = "Custom (from " + (editingPersona?.name || "") + ")";
    }

    const idx = customPersonas.findIndex((c) => c.id === newP.id);
    if (idx >= 0) {
      customPersonas[idx] = newP;
    } else {
      customPersonas = [...customPersonas, newP];
    }
    saveCustomPersonasState();
    closePersonaManager();
    // Apply it immediately
    systemPrompt = newP.prompt;
  }

  function deleteCustomPersona(id: string) {
    // Only delete customs (predefined are protected)
    const isPre = PREDEFINED_PERSONAS.some((p) => p.id === id);
    if (isPre) return;
    customPersonas = customPersonas.filter((c) => c.id !== id);
    saveCustomPersonasState();
  }

  function addNewPersonaQuick() {
    if (!managerNewName.trim() || !managerNewPrompt.trim()) return;
    const newP: Persona = {
      id: `custom-${Date.now()}`,
      name: managerNewName.trim(),
      prompt: managerNewPrompt.trim(),
      description: "Custom persona",
      tags: ["general"],
    };
    customPersonas = [...customPersonas, newP];
    saveCustomPersonasState();
    managerNewName = "";
    managerNewPrompt = "";
    systemPrompt = newP.prompt;
  }

  // Sidecar logs (basic for now)

  // Sync from store (Svelte 5 runes + store)
  let unsubscribe: (() => void) | null = null;

  function syncFromStore(s: any) {
    state.ready = s.ready;
    state.error = s.error;
    state.models = s.models ?? [];
    state.endpoint = s.endpoint;
    state.eps = s.eps ?? [];
    state.acceleratorsReady = s.acceleratorsReady ?? false;
    state.serviceRunning = s.serviceRunning ?? false;
    state.pool = s.pool ?? [];
    state.poolStats = s.poolStats ?? null;
    sidecarLogs = s.logs ?? [];
  }

  // Local reactive derived
  const filteredModels = $derived(
    (state.models || []).filter(
      (m: ModelInfo) =>
        m.alias?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (m as any).family?.toLowerCase?.()?.includes(searchTerm.toLowerCase()),
    ),
  );

  // Persistence for chat history and current model
  const PERSIST_KEY = "flint-chat-persist";

  // Load theme early (before first paint) to avoid flash
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.theme === 'light' || d.theme === 'dark') theme = d.theme;
    }
  } catch {}

  function persistChat() {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          selectedModelAlias,
          selectedSTTModelAlias,
          selectedAccelerationPreference,
          chatMessages,
          systemPrompt,
          contextTurns,
          showFullHistory,
          sidebarCollapsed,
          theme,
          modelRuntimeMeta,
          startupModels,
          autoStartService,
          defaultChatAlias,
          defaultAudioAlias,
          networkPort,
          networkBindAddress,
        }),
      );
    } catch {}
  }
  function restoreChat() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.selectedModelAlias)
          selectedModelAlias = data.selectedModelAlias;
        if (data.selectedSTTModelAlias)
          selectedSTTModelAlias = data.selectedSTTModelAlias;
        if (typeof data.selectedAccelerationPreference === "string") {
          selectedAccelerationPreference = data.selectedAccelerationPreference;
        }
        if (data.chatMessages?.length) chatMessages = data.chatMessages;
        if (data.systemPrompt) systemPrompt = data.systemPrompt;
        if (typeof data.contextTurns === 'number' && data.contextTurns > 0) {
          contextTurns = data.contextTurns;
        }
        if (typeof data.showFullHistory === 'boolean') {
          showFullHistory = data.showFullHistory;
        }
        if (typeof data.sidebarCollapsed === 'boolean') {
          sidebarCollapsed = data.sidebarCollapsed;
        }
        if (data.theme === 'light' || data.theme === 'dark') {
          theme = data.theme;
        }
        if (data.modelRuntimeMeta && typeof data.modelRuntimeMeta === "object") {
          modelRuntimeMeta = data.modelRuntimeMeta;
        }
        if (data.startupModels && typeof data.startupModels === "object") {
          startupModels = data.startupModels;
        }
        if (typeof data.autoStartService === 'boolean') autoStartService = data.autoStartService;
        if (typeof data.defaultChatAlias === 'string') defaultChatAlias = data.defaultChatAlias;
        if (typeof data.defaultAudioAlias === 'string') defaultAudioAlias = data.defaultAudioAlias;
        if (typeof data.networkPort === 'number' && data.networkPort >= 1024 && data.networkPort <= 65535) networkPort = data.networkPort;
        if (typeof data.networkBindAddress === 'string' && data.networkBindAddress) networkBindAddress = data.networkBindAddress;
      }
    } catch {}
  }

  function startSvc(alias?: string, preferredEp?: string) {
    return startService(networkPort, alias, preferredEp, networkBindAddress || undefined);
  }

  $effect(() => {
    // Persist on changes to chat + audio model state
    if (selectedModelAlias || selectedSTTModelAlias || chatMessages.length > 0 || systemPrompt) {
      persistChat();
    }
  });

  function setModelRuntimeMeta(
    alias: string,
    patch: Partial<{ downloadedAt?: string; lastUsedAcceleration?: string }>,
  ) {
    if (!alias) return;
    modelRuntimeMeta = {
      ...modelRuntimeMeta,
      [alias]: {
        ...(modelRuntimeMeta[alias] || {}),
        ...patch,
      },
    };
    persistChat();
  }

  // Apply theme
  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // Persist immediately
    try {
      const existing = JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}');
      existing.theme = theme;
      localStorage.setItem(PERSIST_KEY, JSON.stringify(existing));
    } catch {}
  });

  // Monitor tab polling — 5s while active, pauses when tab hidden, clears on view change
  $effect(() => {
    if (currentView !== 'monitor') return;

    async function pollMonitor() {
      if (document.hidden) return;
      try {
        const [log] = await Promise.all([
          getAccessLog(),
          pollPoolStatus(),
        ]);
        if (!monitorLogPaused) {
          monitorLog = (log ?? []).slice(-100).reverse();
        }
      } catch {}
    }

    pollMonitor();
    const interval = setInterval(pollMonitor, 5000);
    return () => clearInterval(interval);
  });

  async function refreshMonitorNow() {
    const log = await getAccessLog().catch(() => []);
    monitorLog = (log ?? []).slice(-100).reverse();
    await pollPoolStatus().catch(() => {});
  }

  async function runComparison() {
    if (compareSelected.length < 2 || !comparePrompt.trim() || isComparing) return;
    isComparing = true;
    compareResults = {};
    const prompt = comparePrompt.trim();
    const modelsToRun = [...compareSelected];

    await Promise.allSettled(modelsToRun.map(async (alias) => {
      const start = Date.now();
      try {
        // Ensure service/model if needed (pool supports concurrent)
        const res = await chatCompletion(alias, [{ role: 'user', content: prompt }], {
          maxTokens: 512,
          temperature: 0.7,
          preferredEp: selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
        });
        const latency = Date.now() - start;
        const content = res?.choices?.[0]?.message?.content || "";
        // Rough token counts if provided by response
        const usage = res?.usage || {};
        compareResults[alias] = {
          content,
          latencyMs: latency,
          tokensIn: usage.prompt_tokens,
          tokensOut: usage.completion_tokens,
          rating: compareResults[alias]?.rating ?? null,
        };
      } catch (e: any) {
        compareResults[alias] = {
          content: `[Error] ${e?.message || e}`,
          latencyMs: Date.now() - start,
          rating: null,
        };
      }
    }));

    compareResults = { ...compareResults };
    isComparing = false;
  }

  function setCompareRating(alias: string, rating: 'up'|'down') {
    if (!compareResults[alias]) return;
    compareResults[alias].rating = compareResults[alias].rating === rating ? null : rating;
    compareResults = { ...compareResults };
  }

  function exportComparison() {
    let md = `# Model Comparison\n\n**Prompt:** ${comparePrompt}\n\n`;
    Object.entries(compareResults).forEach(([alias, r]) => {
      md += `## ${alias}\n`;
      md += `- Latency: ${r.latencyMs} ms\n`;
      md += `- Tokens: in ${r.tokensIn ?? '?'} / out ${r.tokensOut ?? '?'}\n`;
      md += `- Rating: ${r.rating || 'none'}\n\n`;
      md += `${r.content}\n\n---\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comparison-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function loadModelForCompare(alias: string) {
    try {
      await sdkLoadModel(alias, selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference);
      statusMessage = `Loaded ${alias} for comparison`;
    } catch (e: any) {
      statusMessage = `Failed to load ${alias}: ${e?.message || e}`;
    }
  }

  $effect(() => {
    if (currentView !== 'settings' || isDev) return;
    autostartIsEnabled()
      .then((v: boolean) => { osAutoStartEnabled = v; })
      .catch(() => { osAutoStartEnabled = false; });
  });

  async function handleOsAutoStartToggle(e: Event) {
    if (isDev) return;
    const checked = (e.target as HTMLInputElement).checked;
    try {
      if (checked) {
        await autostartEnable();
      } else {
        await autostartDisable();
      }
      osAutoStartEnabled = checked;
    } catch (err: any) {
      console.error('[settings] OS autostart toggle failed:', err);
      osAutoStartEnabled = !checked;
    }
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase() ?? '';
    const inTypable = tag === 'input' || tag === 'textarea' || tag === 'select';

    if (e.key === '?' && !inTypable) {
      showShortcutsHelp = !showShortcutsHelp;
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && showShortcutsHelp) {
      showShortcutsHelp = false;
      return;
    }

    if (!mod) return;

    switch (e.key) {
      case 'b':
      case 'B':
        if (!e.shiftKey) { e.preventDefault(); sidebarCollapsed = !sidebarCollapsed; persistChat(); }
        break;
      case 'N':
        if (e.shiftKey) { e.preventDefault(); createNewConversation(); }
        break;
      case '1': e.preventDefault(); currentView = 'chat'; break;
      case '2': e.preventDefault(); currentView = 'models'; break;
      case '3': e.preventDefault(); currentView = 'audio'; break;
      case '4': e.preventDefault(); currentView = 'monitor'; refreshMonitorNow(); break;
      case '5': e.preventDefault(); currentView = 'integrations'; break;
      case '6': e.preventDefault(); currentView = 'compare'; break;
      case ',':
        if (!e.shiftKey) { e.preventDefault(); currentView = 'settings'; }
        break;
      case ' ':
        if (!e.shiftKey && currentView === 'chat' && !inTypable) { e.preventDefault(); toggleDictation(); }
        break;
    }
  }

  function exportAccessLog(format: 'json' | 'csv') {
    const entries = [...monitorLog].reverse(); // restore chronological order
    let content: string;
    let mime: string;
    let ext: string;
    if (format === 'json') {
      content = JSON.stringify(entries, null, 2);
      mime = 'application/json';
      ext = 'json';
    } else {
      const headers = 'time,type,model,durationMs,tokensIn,tokensOut,ok';
      const rows = entries.map(e =>
        [new Date(e.ts).toISOString(), e.type, e.modelAlias ?? '', e.durationMs ?? '', e.tokensIn ?? '', e.tokensOut ?? '', e.ok].join(',')
      );
      content = [headers, ...rows].join('\n');
      mime = 'text/csv';
      ext = 'csv';
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `flint-access-log-${stamp}.${ext}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function init() {
    statusMessage = "Initializing Foundry Local SDK...";

    // Load conversation history + custom personas
    loadConversations();
    loadCustomPersonasState();

    const ok = await initializeSDK({ appName: "flint" });

    if (ok) {
      statusMessage = "Connected to Foundry Local";
      await loadModels();
      await loadRecommendations();
      await loadSTTModels();

      // Restore previous chat if any
      restoreChat();

      // Auto setup accelerators (background)
      ensureHardwareAccel().catch(console.error);

      // Auto first launch: if no cached models and no persisted chat, auto use first recommended
      const hasAnyCached = state.models.some((m: ModelInfo) => m.isCached);
      const hasPersisted = !!localStorage.getItem(PERSIST_KEY);
      if (!hasAnyCached && !hasPersisted && recommendedStarters.length > 0) {
        statusMessage = `First launch detected — auto-starting with ${recommendedStarters[0].alias}...`;
        // Auto do it after short delay so UI updates
        setTimeout(() => {
          if (recommendedStarters[0]) {
            useStarterModel(recommendedStarters[0]);
          }
        }, 600);
      } else if (autoStartService) {
        const targetAlias = defaultChatAlias || selectedModelAlias;
        if (targetAlias && !selectedModel) {
          const existing = state.models.find(
            (m: ModelInfo) => m.alias === targetAlias,
          );
          if (existing?.isCached) {
            const usingDefault = !!defaultChatAlias;
            try {
              if (!existing.isLoaded) {
                statusMessage = usingDefault
                  ? `Auto-loading ${targetAlias}...`
                  : `Restoring ${targetAlias} from previous session...`;
                await loadModelAndMaybeStart(existing);
              } else if (!state.serviceRunning) {
                await startSvc(
                  targetAlias,
                  selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
                );
              }
              selectedModelAlias = targetAlias;
              selectedModel = { alias: targetAlias };
              chatClient = null;
              statusMessage = usingDefault
                ? `${targetAlias} ready`
                : `${targetAlias} restored from previous session`;
            } catch (e: any) {
              statusMessage = `Failed to restore ${targetAlias}: ${e?.message || e}`;
            }
          }
        }
        if (defaultAudioAlias) selectedSTTModelAlias = defaultAudioAlias;
      }

      // Load any additional startup models (multi-model pool pre-warm)
      const startupEntries = Object.entries(startupModels);
      if (startupEntries.length > 0) {
        let startupLoaded = 0;
        for (const [alias, variantId] of startupEntries) {
          if (alias === selectedModelAlias) continue; // already loading above
          const model = state.models.find((m: ModelInfo) => m.alias === alias);
          if (model?.isCached) {
            try {
              statusMessage = `Auto-loading ${alias}...`;
              await sdkLoadModel({ alias }, undefined, variantId ?? undefined);
              startupLoaded++;
            } catch (e: any) {
              console.warn(`Startup auto-load failed for ${alias}:`, e);
            }
          }
        }
        if (startupLoaded > 0) {
          await refreshModels();
          statusMessage = `${startupLoaded} startup model${startupLoaded !== 1 ? 's' : ''} loaded`;
        }
      }
    } else {
      statusMessage = state.error || "Could not connect to Foundry Local";
    }
  }

  async function loadModels() {
    if (!state.ready) return;
    isLoadingModels = true;
    try {
      await refreshModels();
      statusMessage = `${state.models.length} models available`;
      // Keep STT list fresh too (metadata driven)
      loadSTTModels().catch(() => {});
    } catch (e: any) {
      statusMessage = `Failed to load catalog: ${e?.message || e}`;
    } finally {
      isLoadingModels = false;
    }
  }

  async function loadRecommendations() {
    if (!state.ready) return;
    isLoadingRecommendations = true;
    try {
      recommendedStarters = await getRecommendedStarterModels(3);
    } catch (e) {
      console.warn("Recommendations failed", e);
      recommendedStarters = [];
    } finally {
      isLoadingRecommendations = false;
    }
  }

  async function loadSTTModels() {
    if (!state.ready) return;
    try {
      sttModels = await getSTTModels();
    } catch (e) {
      console.warn("Failed to load STT models", e);
      sttModels = [];
    }
  }

  async function startLocalService() {
    try {
      statusMessage = "Starting local service...";
      appendAppLog('Starting local OpenAI-compatible service');
      const ep = await startSvc(
        selectedModelAlias || undefined,
        selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
      );
      updateStateFromSdk();
      statusMessage = `Service running at ${ep}`;
      appendAppLog(`Service started at ${ep}`);
    } catch (e: any) {
      statusMessage = `Failed to start service: ${e?.message || e}`;
      appendAppLog(`Service start failed: ${e?.message || e}`, 'error');
    }
  }

  async function stopLocalService() {
    try {
      await stopService();
      updateStateFromSdk();
      statusMessage = "Service stopped";
      appendAppLog('Service stopped');
    } catch (e: any) {
      statusMessage = `Failed to stop service: ${e?.message || e}`;
      appendAppLog(`Service stop failed: ${e?.message || e}`, 'error');
    }
  }

  async function refreshServiceStatus() {
    await refreshModels();
    updateStateFromSdk();
  }

  async function copyDiagnosticsToClipboard() {
    const diagnosticsSnapshot = {
      generatedAt: new Date().toISOString(),
      app: {
        view: currentView,
        selectedModelAlias: selectedModelAlias || null,
        selectedAccelerationPreference,
        statusMessage,
      },
      sdkState: {
        ready: state.ready,
        error: state.error,
        endpoint: state.endpoint || null,
        serviceRunning: state.serviceRunning,
        acceleratorsReady: state.acceleratorsReady,
        executionProviders: state.eps,
        modelCount: state.models.length,
        cachedModelCount: state.models.filter((m) => m.isCached).length,
        loadedModelCount: state.models.filter((m) => m.isLoaded).length,
        models: state.models.map((m) => ({
          alias: m.alias,
          isCached: !!m.isCached,
          isLoaded: !!m.isLoaded,
          info: (m as any).info || null,
        })),
      },
      logs: sidecarLogs.map(e => {
        const d = new Date(e.ts);
        const t = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
        return `[${t}][${e.source}][${e.level}] ${e.message}`;
      }),
      runtime: {
        userAgent: navigator.userAgent,
        platform: navigator.platform || "unknown",
        language: navigator.language,
      },
    };

    const payload =
      `Flint Diagnostic Snapshot\n` +
      `Generated: ${diagnosticsSnapshot.generatedAt}\n\n` +
      JSON.stringify(diagnosticsSnapshot, null, 2);

    try {
      await navigator.clipboard.writeText(payload);
      statusMessage = `Copied diagnostics to clipboard (${sidecarLogs.length} logs)`;
    } catch (e: any) {
      statusMessage = `Failed to copy diagnostics: ${e?.message || e}`;
    }
  }

  function updateStateFromSdk() {
    // The sdk.ts already updates the store on refresh/startService
  }

  async function ensureHardwareAccel() {
    if (!state.ready) return;
    statusMessage = "Setting up hardware accelerators...";
    try {
      await ensureAccelerators((epName, pct) => {
        statusMessage = `Accelerator ${epName}: ${pct.toFixed(0)}%`;
      });
      statusMessage =
        state.acceleratorsReady ?
          "Hardware acceleration ready"
        : "Accelerators configured";
      await refreshExecutionProviders();
      await refreshModels();
      await loadRecommendations();
    } catch (e: any) {
      statusMessage = `Accel setup: ${e?.message || "partial"}`;
    }
  }

  async function useStarterModel(model: ModelInfo) {
    if (!modelSupportsChat(model)) {
      statusMessage = `${model.alias} is not a chat model.`;
      return;
    }
    try {
      const alias = model.alias;

      if (!model.isCached) {
        statusMessage = `Downloading recommended model ${alias}...`;
        await downloadAndTrack(model);
      }
      if (!model.isLoaded) {
        statusMessage = `Loading ${alias}...`;
        await loadModelAndMaybeStart(model);
      }

      selectedModelAlias = alias;
      selectedModel = { alias }; // minimal handle
      chatClient = null; // use HTTP from sidecar
      chatMessages = [];
      chatInput = "";
      lastAutoSummaryCount = 0;

      // Auto start service and switch to chat
      if (!state.serviceRunning) {
        try {
          await startSvc(
            alias,
            selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
          );
        } catch {}
      }

      statusMessage = `${alias} ready. Switching to chat...`;
      currentView = "chat";
    } catch (e: any) {
      statusMessage = `Failed with starter: ${e?.message || e}`;
    }
  }

  async function selectAndChat(model: any) {
    if (!modelSupportsChat(model)) {
      statusMessage = `${model.alias} is an STT/audio model and cannot be used for chat.`;
      currentView = 'audio';
      await useSTTModelForAudio(model).catch(() => {});
      return;
    }
    try {
      selectedModelAlias = model.alias;
      selectedModel = { alias: model.alias };
      chatClient = null;
      chatMessages = [];
      chatInput = "";
      currentView = "chat";
      lastAutoSummaryCount = 0;
      statusMessage = `Chatting with ${model.alias}`;

      // === Step 4: apply good default for this model
      if (recommendedMaxTurns && recommendedMaxTurns !== contextTurns) {
        contextTurns = recommendedMaxTurns;
      }

      if (!state.serviceRunning) {
        try {
          await startSvc(
            model.alias,
            selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
          );
        } catch {}
      }
    } catch (e: any) {
      statusMessage = `Failed to select: ${e?.message || e}`;
    }
  }

  async function loadAndSelect(model: any) {
    if (!modelSupportsChat(model)) {
      statusMessage = `${model.alias} is an STT/audio model. Switching to Audio tab.`;
      await useSTTModelForAudio(model);
      currentView = 'audio';
      return;
    }
    try {
      await loadModelAndMaybeStart(model);
      await selectAndChat(model);
    } catch (e: any) {
      statusMessage = `Load failed: ${e?.message || e}`;
    }
  }

  // Dedicated path for audio/STT: loads the model in the audio lane without
  // affecting the chat lane or the running chat service endpoint.
  async function useSTTModelForAudio(model: any) {
    try {
      const alias = model.alias;

      if (!model.isCached) {
        statusMessage = `Downloading STT model ${alias}...`;
        await downloadAndTrack(model);
      }

      statusMessage = `Loading ${alias} for audio transcription...`;
      await sendLoadToSidecar(model, 'audio');
      selectedSTTModelAlias = alias;
      audioLaneModelAlias = alias;

      statusMessage = `Audio ready: ${alias}`;
      await refreshModels();
      await loadSTTModels();
    } catch (e: any) {
      statusMessage = `Failed to prepare STT model: ${e?.message || e}`;
    }
  }

  onMount(() => {
    hostPlatform = detectHostPlatform();
    // Subscribe to the SDK store
    unsubscribe = sdkStateStore.subscribe(syncFromStore);
    // Load conversation history
    loadConversations();
    init();
    document.addEventListener('keydown', handleGlobalKeydown);

    return () => {
      if (unsubscribe) unsubscribe();
      saveConversations();
      document.removeEventListener('keydown', handleGlobalKeydown);
    };
  });

  // Auto-save conversations when messages change (Svelte 5 runes style)
  $effect(() => {
    if (currentConversationId && chatMessages.length > 0) {
      saveConversations();
    }
  });

  async function downloadAndTrack(model: any) {
    downloadingModelAliases = { ...downloadingModelAliases, [model.alias]: true };
    try {
      statusMessage = `Downloading ${model.alias}...`;
      await downloadModel(model, (p: number) => {
        statusMessage = `Downloading ${model.alias}: ${p.toFixed(1)}%`;
      });
      setModelRuntimeMeta(model.alias, { downloadedAt: new Date().toISOString() });
      statusMessage = `${model.alias} downloaded`;
      await refreshModels();
    } catch (e: any) {
      statusMessage = `Download failed: ${e?.message || e}`;
      throw e;
    } finally {
      const next = { ...downloadingModelAliases };
      delete next[model.alias];
      downloadingModelAliases = next;
    }
  }

  async function loadModelAndMaybeStart(model: any) {
    try {
      statusMessage = `Loading ${model.alias}...`;
      appendAppLog(`Loading model ${model.alias} (chat lane)`);
      const loadResult = await sendLoadToSidecar(model, 'chat');
      const loadAccel = String(loadResult?.acceleration?.active || "").trim();
      if (loadAccel) {
        setModelRuntimeMeta(model.alias, { lastUsedAcceleration: loadAccel });
      }
      statusMessage = `${model.alias} loaded`;

      if (!state.serviceRunning) {
        try {
          await startSvc(
            model.alias,
            selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
          );
          statusMessage = `${model.alias} loaded + service started`;
        } catch (e) {
          console.warn("Auto-start service failed", e);
        }
      }

      await refreshModels();

      // If this was an STT model loaded from the main UI (e.g. Models tab "Load" button),
      // make the Audio page inherit it automatically.
      if (modelSupportsAudio(model)) {
        selectedSTTModelAlias = model.alias;
      }
    } catch (e: any) {
      statusMessage = `Load failed: ${e?.message || e}`;
    }
  }

  async function sendLoadToSidecar(model: any, lane?: 'chat' | 'audio') {
    return await sdkLoadModel(model, lane);
  }

  async function unloadModel(model: any) {
    try {
      statusMessage = `Unloading ${model.alias}...`;
      await sdkUnloadModel(model);
      statusMessage = `${model.alias} unloaded`;
      await refreshModels();
    } catch (e: any) {
      statusMessage = `Unload failed: ${e?.message || e}`;
    }
  }

  async function loadVariant(model: any, variantId: string) {
    try {
      statusMessage = `Loading ${model.alias} (${variantId.split(':')[0].split('-').slice(-2).join('-')})...`;
      appendAppLog(`Loading model ${model.alias} variant ${variantId}`);
      await sdkLoadModel(model, undefined, variantId);
      statusMessage = `${model.alias} loaded`;
      if (!state.serviceRunning) {
        try {
          await startSvc(model.alias, undefined);
        } catch {}
      }
      await refreshModels();
    } catch (e: any) {
      statusMessage = `Load failed: ${e?.message || e}`;
    }
  }

  async function downloadVariant(model: any, variantId: string) {
    downloadingVariantIds = { ...downloadingVariantIds, [variantId]: true };
    try {
      statusMessage = `Downloading ${model.alias} variant...`;
      await downloadModel(model, (p: number) => {
        statusMessage = `Downloading ${model.alias}: ${p.toFixed(1)}%`;
      }, variantId);
      setModelRuntimeMeta(model.alias, { downloadedAt: new Date().toISOString() });
      statusMessage = `${model.alias} variant downloaded`;
      await refreshModels();
    } catch (e: any) {
      statusMessage = `Download failed: ${e?.message || e}`;
    } finally {
      const next = { ...downloadingVariantIds };
      delete next[variantId];
      downloadingVariantIds = next;
    }
  }

  function accelBadgeInfo(deviceType: string | null, ep: string | null): { label: string; cls: string } {
    const device = deviceType ?? 'CPU';
    const epNorm = (ep ?? 'generic').toLowerCase().replace(/executionprovider$/i, '').trim();
    let epLabel: string;
    let cls: string;
    if (epNorm === 'cuda')                        { epLabel = 'CUDA';      cls = 'ep-cuda';      }
    else if (epNorm === 'qnn')                    { epLabel = 'QNN';       cls = 'ep-qnn';       }
    else if (epNorm === 'dml')                    { epLabel = 'DirectML';  cls = 'ep-dml';       }
    else if (epNorm.includes('openvino'))         { epLabel = 'OpenVINO';  cls = 'ep-openvino';  }
    else if (epNorm === 'webgpu')                 { epLabel = 'WebGPU';    cls = 'ep-webgpu';    }
    else if (epNorm.includes('tensorrt'))         { epLabel = 'TensorRT';  cls = 'ep-tensorrt';  }
    else if (epNorm.includes('vitis'))            { epLabel = 'Vitis';     cls = 'ep-vitis';     }
    else                                          { epLabel = 'Generic';   cls = 'ep-generic';   }
    return { label: `${device} (${epLabel})`, cls };
  }

  function toggleStartup(alias: string, variantId: string | null) {
    if (startupModels[alias] !== undefined) {
      const updated = { ...startupModels };
      delete updated[alias];
      startupModels = updated;
    } else {
      // Capture the currently loaded variant so the right device type reloads on startup
      const activeVariantId = state.pool.find((e: any) => e.alias === alias)?.variantId ?? variantId;
      startupModels = { ...startupModels, [alias]: activeVariantId };
    }
    persistChat();
  }

  async function deleteCachedModel(model: any) {
    try {
      const confirmed = globalThis.confirm(
        `Delete cached model "${model.alias}" from disk? This cannot be undone.`,
      );
      if (!confirmed) {
        statusMessage = `Delete cancelled for ${model.alias}`;
        return;
      }
      statusMessage = `Deleting ${model.alias}...`;
      if (model.isLoaded) {
        await sdkUnloadModel(model);
      }
      await sdkDeleteModel(model);
      if (selectedModelAlias === model.alias) {
        selectedModelAlias = "";
      }
      if (modelRuntimeMeta[model.alias]) {
        const nextMeta = { ...modelRuntimeMeta };
        delete nextMeta[model.alias];
        modelRuntimeMeta = nextMeta;
        persistChat();
      }
      statusMessage = `${model.alias} deleted`;
      await refreshModels();
    } catch (e: any) {
      statusMessage = `Delete failed: ${e?.message || e}`;
    }
  }

  async function sendMessage(e: Event) {
    e.preventDefault();
    if (chatBlockedByLoadedSTT) {
      statusMessage = "Text chat is disabled while an STT model is active. Load a chat model to continue.";
      return;
    }
    if (!selectedModelSupportsChat) {
      statusMessage = "Current model does not support chat completions.";
      return;
    }
    if (!chatInput.trim() || (!state.endpoint && !chatClient) || isStreaming) return;

    const text = chatInput.trim();
    let userContent: any = text;
    if (attachedImages.length > 0 && isVisionModel) {
      userContent = [
        { type: "text", text },
        ...attachedImages.map((url) => ({ type: "image_url", image_url: { url } }))
      ];
    }
    chatMessages = [...chatMessages, { role: "user", content: userContent }];
    chatInput = "";
    clearImages(); // clear after queuing for send
    isStreaming = true;
    const requestController = new AbortController();
    abortController = requestController;
    activeStreamRequestId = null;

    // Scroll to bottom
    setTimeout(() => {
      if (messagesContainer)
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 0);

    try {
      let assistantContent = "";
      chatMessages = [...chatMessages, { role: "assistant", content: "" }];

      // Prefer HTTP endpoint from sidecar when available (clean architecture)
      const endpoint = state.endpoint;
      if (endpoint) {
        const inferenceMessages = getMessagesForInference();
        const data = await chatCompletionStream(
          selectedModelAlias,
          inferenceMessages,
          (delta: string) => {
            if (requestController.signal.aborted) return;
            assistantContent += delta;
            const lastIndex = chatMessages.length - 1;
            chatMessages[lastIndex] = {
              ...chatMessages[lastIndex],
              content: assistantContent,
            };
            chatMessages = [...chatMessages];
          },
          {
            preferredEp: selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
          },
          (requestId: number) => {
            activeStreamRequestId = requestId;
          },
        );
        if (requestController.signal.aborted) {
          return;
        }
        const endpointAcceleration = String(data?.acceleration?.active || "").trim();
        if (endpointAcceleration && selectedModelAlias) {
          setModelRuntimeMeta(selectedModelAlias, { lastUsedAcceleration: endpointAcceleration });
        }
        assistantContent = data?.choices?.[0]?.message?.content || assistantContent;
        const lastIndex = chatMessages.length - 1;
        chatMessages[lastIndex] = {
          ...chatMessages[lastIndex],
          content: assistantContent,
        };
        chatMessages = [...chatMessages];
        setTimeout(() => {
          if (messagesContainer)
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 5);
      } else if (chatClient) {
        // Fallback to direct client (dev only)
        const inferenceMessages = getMessagesForInference();
        for await (const chunk of chatClient.completeStreamingChat(inferenceMessages)) {
          if (requestController.signal.aborted) break;
          const delta = chunk.choices?.[0]?.delta?.content || "";
          if (delta) {
            assistantContent += delta;
            const lastIndex = chatMessages.length - 1;
            chatMessages[lastIndex] = {
              ...chatMessages[lastIndex],
              content: assistantContent,
            };
            chatMessages = [...chatMessages];
          }
        }
      }
    } catch (err: any) {
      if (!requestController.signal.aborted) {
        const lastIndex = chatMessages.length - 1;
        chatMessages[lastIndex] = {
          ...chatMessages[lastIndex],
          isError: true,
          content:
            (chatMessages[lastIndex].content || "") +
            "\n\n[Error: " +
            (err?.message || err) +
            "]",
        };
        chatMessages = [...chatMessages];
      }
    } finally {
      isStreaming = false;
      activeStreamRequestId = null;
      if (abortController === requestController) {
        abortController = null;
      }
    }
  }

  async function stopGeneration() {
    if (abortController) {
      abortController.abort();
      if (activeStreamRequestId != null) {
        try {
          await cancelChatRequest(activeStreamRequestId);
        } catch (e: any) {
          statusMessage = `Stop warning: ${e?.message || e}`;
        }
      }
      isStreaming = false;
      statusMessage = "Generation stopped by user";
    }
  }

  /**
   * Normalizes messages for strict chat templates (e.g., Mistral Instruct)
   * that require only user/assistant roles and strict alternation.
   */
  function normalizeForAlternatingChat(
    messages: Array<{ role: string; content: any }>,
    systemInstruction?: string,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const instructionParts: string[] = [];
    if (systemInstruction?.trim()) instructionParts.push(systemInstruction.trim());

    const normalized: Array<{ role: "user" | "assistant"; content: any }> = [];
    for (const message of messages || []) {
      const role = String(message?.role || "").toLowerCase();
      const rawContent = message?.content;
      // For vision: keep array form; for text keep string
      const content = Array.isArray(rawContent) ? rawContent : String(rawContent ?? "").trim();
      if (!content || (typeof content === 'string' && !content)) continue;
      if (role === "system" && typeof content === 'string') {
        instructionParts.push(content);
        continue;
      }
      if (role === "user" || role === "assistant") {
        normalized.push({ role, content });
      }
    }

    const instructionText = instructionParts.length
      ? `Follow these instructions:\n${instructionParts.join("\n\n")}`
      : "";

    if (instructionText) {
      if (normalized.length > 0 && normalized[0].role === "user") {
        normalized[0] = {
          role: "user",
          content: `${instructionText}\n\n${normalized[0].content}`,
        };
      } else {
        normalized.unshift({ role: "user", content: instructionText });
      }
    }

    const alternating: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const message of normalized) {
      if (alternating.length === 0) {
        if (message.role !== "user") continue;
        alternating.push(message);
        continue;
      }
      const previous = alternating[alternating.length - 1];
      if (previous.role === message.role) {
        previous.content = `${previous.content}\n\n${message.content}`;
        continue;
      }
      alternating.push(message);
    }

    return alternating;
  }

  /**
   * Builds the messages array to send to the model.
   *
   * Key design decisions for local inference:
   * - We NEVER mutate the full `chatMessages` (user can always see full history).
   * - We apply a sliding window based on `contextTurns` to keep token usage reasonable.
   * - We normalize to strict user/assistant alternation for model compatibility.
   * - This directly affects latency + energy use, even on powerful local hardware.
   */
  function getMessagesForInference(): any[] {
    // Remove any trailing empty assistant placeholder (from streaming setup)
    let history = [...chatMessages];
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last.role === 'assistant' && !last.content?.trim()) {
        history = history.slice(0, -1);
      }
    }

    // Filter out condensed raw messages (keep summaries and pinned and recent)
    // This keeps the inference payload small while full thread stays readable.
    const effectiveHistory = history.filter((m: any) => {
      if (m.condensed && !m.isSummary && !m.pinned) return false;
      if (m.isError) return false;
      return true;
    });

    // === Step 5: Respect pinned messages ===
    const pinned = effectiveHistory.filter((m: any) => m.pinned);
    const nonPinned = effectiveHistory.filter((m: any) => !m.pinned);

    const maxRecent = Math.max(2, contextTurns * 2);
    const recentNonPinned = nonPinned.slice(-maxRecent);

    // Combine: pinned first (they act as long-term memory), then recent
    // Dedup by reference
    const combined = [...pinned];
    for (const m of recentNonPinned) {
      if (!combined.includes(m)) combined.push(m);
    }

    return normalizeForAlternatingChat([
      ...combined.map((m: any) => ({
        role: m.role,
        content: m.content, // can be string or vision array [{type,text}, {type:'image_url',...}]
      })),
    ], systemPrompt);
  }

  /**
   * === Step 3: Better token counting ===
   * Improved heuristic + can be upgraded with sidecar tokenizer in future.
   * We use a blended heuristic that works reasonably for English + code.
   */
  function estimateTokens(text: string): number {
    if (!text) return 0;
    const chars = text.length;
    const words = text.trim().split(/\s+/).length;
    // Blended heuristic:
    // - ~3.8-4.2 chars per token common for many tokenizers
    // - Word-based backup: ~1.3-1.4 tokens per word for English
    const charBased = chars / 3.9;
    const wordBased = words * 1.33;
    return Math.ceil(Math.max(charBased, wordBased));
  }

  function estimateTokensForMessages(msgs: any[]): number {
    let total = 0;
    for (const m of msgs) {
      if (Array.isArray(m.content)) {
        // Vision content: sum text parts + rough overhead per image (approx for 0.3)
        for (const part of m.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            total += estimateTokens(part.text);
          } else if (part.type === 'image_url') {
            total += 500; // rough overhead per image (base64 + encoding)
          }
        }
      } else {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        total += estimateTokens(text);
      }
    }
    // Add a bit for roles / formatting overhead
    return total + Math.ceil(msgs.length * 1.5);
  }

  /**
   * === Step 2: Auto / Manual Summarization ===
   * Non-destructive version: keeps the full thread for reading.
   * Marks older messages as `condensed` and inserts a summary message.
   * Full history remains accessible via the "Full thread" toggle.
   */
  async function compactConversationWithSummary(turnsToKeep = 6) {
    if (chatMessages.length < turnsToKeep * 2 + 4) {
      statusMessage = "Not enough history to summarize yet.";
      return;
    }
    if (!state.endpoint && !chatClient) {
      statusMessage = "Need a loaded model + service to summarize.";
      return;
    }

    const splitIndex = chatMessages.length - turnsToKeep * 2;
    const oldMessages = chatMessages.slice(0, splitIndex);
    const keepMessages = chatMessages.slice(splitIndex);

    const summaryPrompt = `You are a precise conversation summarizer.
Summarize the following conversation history concisely in 4-8 sentences.
Focus on: key facts the user shared, important decisions, open questions, user goals/preferences, and any code or specific details worth remembering.
Output only the summary text, no preamble.`;

    const summaryMessages = normalizeForAlternatingChat([
      ...oldMessages.map((m: any) => ({ role: m.role, content: m.content }))
    ], summaryPrompt);

    statusMessage = "Summarizing older context...";
    let summary = "";

    try {
      const endpoint = state.endpoint;
      if (endpoint) {
        const data = await chatCompletion(selectedModelAlias, summaryMessages, {
          maxTokens: 600,
          temperature: 0.3,
          preferredEp: selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
        });
        summary = data.choices?.[0]?.message?.content || "";
      } else if (chatClient) {
        // Fallback non-stream (best effort)
        try {
          const result: any = await (chatClient as any).completeChat?.(summaryMessages) || {};
          summary = result.choices?.[0]?.message?.content || "";
        } catch {}
      }
    } catch (e: any) {
      statusMessage = `Summarization failed: ${e?.message || e}. Using condense instead.`;
      // Non-destructive fallback
      oldMessages.forEach((m: any) => { if (!m.pinned && !m.isSummary) m.condensed = true; });
      chatMessages = [...chatMessages];
      return;
    }

    if (!summary.trim()) {
      statusMessage = "Summary was empty. Condensed instead.";
      oldMessages.forEach((m: any) => { if (!m.pinned && !m.isSummary) m.condensed = true; });
      chatMessages = [...chatMessages];
      return;
    }

    const summaryMessage = {
      role: "assistant",
      content: `[Previous conversation summary — ${oldMessages.length} earlier messages]:\n${summary.trim()}`,
      isSummary: true,
    };

    // Mark old non-pinned non-summary messages as condensed (they stay in the array for full thread)
    oldMessages.forEach((m: any) => {
      if (!m.pinned && !m.isSummary) m.condensed = true;
    });

    // Insert the summary at the position where the old part started
    chatMessages = [...chatMessages.slice(0, splitIndex), summaryMessage, ...keepMessages];
    statusMessage = "Conversation compacted with summary. Full thread still available via toggle.";
  }

  function attachImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true; // support multi-image
    input.onchange = (e: any) => {
      const files: FileList = e.target.files;
      if (!files) return;
      const max = 4;
      const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB decoded approx (base64 will be ~33% larger)
      for (const file of Array.from(files)) {
        if (attachedImages.length >= max) break;
        if (file.size > MAX_IMAGE_SIZE) {
          statusMessage = `Image ${file.name} is too large (max ~5MB)`;
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          // Rough check on base64 size too
          if (dataUrl.length > MAX_IMAGE_SIZE * 1.4) {
            statusMessage = `Image ${file.name} is too large after encoding`;
            return;
          }
          if (attachedImages.length < max) {
            attachedImages = [...attachedImages, dataUrl];
          }
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }

  function removeImage(index: number) {
    attachedImages = attachedImages.filter((_, i) => i !== index);
  }

  function clearImages() {
    attachedImages = [];
  }

  // Drag & drop support for images (only when vision model)
  function handleDragOver(e: DragEvent) {
    if (!isVisionModel) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }
  function handleDrop(e: DragEvent) {
    if (!isVisionModel) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    const max = 4 - attachedImages.length;
    for (const file of imageFiles.slice(0, max)) {
      const reader = new FileReader();
      reader.onload = () => {
        if (attachedImages.length < 4) attachedImages = [...attachedImages, reader.result as string];
      };
      reader.readAsDataURL(file);
    }
  }

  // Enhanced paste for multiple images
  function handlePaste(e: ClipboardEvent) {
    if (!isVisionModel) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const max = 4 - attachedImages.length;
    for (const item of imageItems.slice(0, max)) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (attachedImages.length < 4) attachedImages = [...attachedImages, reader.result as string];
      };
      reader.readAsDataURL(file);
    }
  }

  // Audio functions
  async function toggleRecording() {
    if (isRecording) {
      // Stop
      if (mediaRecorder) {
        mediaRecorder.stop();
      }
      isRecording = false;
      statusMessage = "Recording stopped";
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
          audioBlob = new Blob(audioChunks, { type: "audio/webm" });
          // Stop tracks
          stream.getTracks().forEach((track) => track.stop());
          statusMessage = "Recording saved. Ready to transcribe.";
        };

        // Use timeslice so we get regular chunks even for long recordings.
        // The final Blob from all chunks will contain the full audio.
        mediaRecorder.start(1000);
        isRecording = true;
        audioBlob = null;
        statusMessage = "Recording...";
      } catch (err) {
        statusMessage = `Mic error: ${err}`;
      }
    }
  }

  async function toggleDictation() {
    if (isDictating) {
      if (dictationMediaRecorder && dictationMediaRecorder.state !== 'inactive') {
        dictationMediaRecorder.stop();
      }
    } else {
      const sttAlias = effectiveSTTModelAlias || 'whisper-tiny';
      try {
        dictationStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        dictationMediaRecorder = new MediaRecorder(dictationStream);
        dictationChunks = [];
        dictationInterim = '';
        isRollingTranscribe = false;

        dictationMediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            dictationChunks = [...dictationChunks, event.data];
            if (!isRollingTranscribe) triggerRollingTranscription(sttAlias);
          }
        };

        dictationMediaRecorder.onstop = async () => {
          dictationStream?.getTracks().forEach((t) => t.stop());
          isDictating = false;
          const chunks = dictationChunks;
          dictationChunks = [];
          if (chunks.length === 0) { dictationInterim = ''; return; }
          try {
            const fullBlob = new Blob(chunks, { type: 'audio/webm' });
            const wavBlob = await convertAudioBlobToWav(fullBlob).catch(() => fullBlob);
            const res = await transcribeAudio(wavBlob, sttAlias, transcriptionLanguage, 'dictation.wav', { temperature: 0 });
            const text = getTranscriptTextFromResult(res);
            if (text) chatInput = chatInput ? `${chatInput} ${text}` : text;
          } catch (err) {
            statusMessage = `Dictation failed: ${err}`;
          } finally {
            dictationInterim = '';
          }
        };

        dictationMediaRecorder.start(2000);
        isDictating = true;
      } catch (err) {
        dictationStream?.getTracks().forEach((t) => t.stop());
        dictationStream = null;
        dictationMediaRecorder = null;
        dictationChunks = [];
        dictationInterim = '';
        isDictating = false;
        statusMessage = `Dictation mic error: ${err}`;
      }
    }
  }

  async function triggerRollingTranscription(sttAlias: string) {
    if (isRollingTranscribe || dictationChunks.length === 0) return;
    isRollingTranscribe = true;
    const snapshotLen = dictationChunks.length;
    try {
      const windowChunks = dictationChunks.slice(-2); // ~last 4s (timeslice=2000ms)
      const blob = new Blob(windowChunks, { type: 'audio/webm' });
      const wavBlob = await convertAudioBlobToWav(blob).catch(() => blob);
      const res = await transcribeAudio(wavBlob, sttAlias, transcriptionLanguage, 'dictation-interim.wav', { temperature: 0 });
      const text = getTranscriptTextFromResult(res);
      if (text && isDictating) dictationInterim = text;
    } catch {
      // rolling transcription is best-effort; failures are silent
    } finally {
      isRollingTranscribe = false;
      if (isDictating && dictationChunks.length > snapshotLen) {
        triggerRollingTranscription(sttAlias);
      }
    }
  }

  async function uploadAudioFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.wav,.mp3,.webm,.m4a";
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (file) {
        audioBlob = file;
        statusMessage = `File selected: ${file.name}`;
      }
    };
    input.click();
  }

  // Convert any audio Blob the browser can decode into 16 kHz mono 16-bit WAV.
  // The ONNX Runtime GenAI decoder used by many Foundry Local Whisper models
  // is strict and commonly fails with "Cannot detect audio stream format"
  // on WebM/Opus, MP3, etc.
  async function getMono16kBuffer(blob: Blob): Promise<AudioBuffer> {
    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    const audioCtx = new AudioContextClass();
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);

      const targetRate = 16000;
      const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
      const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);

      const source = offlineCtx.createBufferSource();
      source.buffer = decoded;
      source.connect(offlineCtx.destination);
      source.start(0);

      return await offlineCtx.startRendering();
    } finally {
      try {
        await audioCtx.close();
      } catch (closeError) {
        console.warn("Failed to close AudioContext after audio normalization decode", closeError);
      }
    }
  }

  async function convertAudioBlobToWav(blob: Blob): Promise<Blob> {
    const rendered = await getMono16kBuffer(blob);
    const wavBuffer = audioBufferToWav(rendered);
    return new Blob([wavBuffer], { type: "audio/wav" });
  }

  function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const bufferLength = 44 + dataLength;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return arrayBuffer;
  }

  function writeString(view: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /**
   * Chunk long audio into ~28s segments (with overlap) and transcribe each.
   * This is required because many local Whisper implementations (including the
   * ONNX/GenAI backend used here) only reliably process a limited prefix
   * when given very long single files.
   */
  function normalizeTranscriptText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function getTranscriptTextFromResult(result: any): string {
    if (typeof result?.text === "string" && result.text.trim()) {
      return normalizeTranscriptText(result.text);
    }
    if (Array.isArray(result?.segments)) {
      return normalizeTranscriptText(
        result.segments.map((s: any) => s?.text || s?.transcript || "").join(" ")
      );
    }
    return "";
  }

  function findWordOverlapTailPrefix(previousText: string, nextText: string, maxWords = 24): number {
    const prevWords = normalizeTranscriptText(previousText).split(" ").filter(Boolean);
    const nextWords = normalizeTranscriptText(nextText).split(" ").filter(Boolean);
    const max = Math.min(maxWords, prevWords.length, nextWords.length);
    for (let overlap = max; overlap > 0; overlap--) {
      const prevTail = prevWords.slice(prevWords.length - overlap).join(" ").toLowerCase();
      const nextHead = nextWords.slice(0, overlap).join(" ").toLowerCase();
      if (prevTail === nextHead) return overlap;
    }
    return 0;
  }

  function mergeTranscriptChunks(chunks: string[]): string {
    const cleaned = chunks.map((c) => normalizeTranscriptText(c)).filter(Boolean);
    if (cleaned.length === 0) return "";
    let merged = cleaned[0];
    for (let i = 1; i < cleaned.length; i++) {
      const next = cleaned[i];
      const overlapWords = findWordOverlapTailPrefix(merged, next);
      if (overlapWords > 0) {
        const nextWords = next.split(" ");
        merged = `${merged} ${nextWords.slice(overlapWords).join(" ")}`.trim();
      } else if (!merged.toLowerCase().includes(next.toLowerCase())) {
        merged = `${merged} ${next}`.trim();
      }
    }
    return normalizeTranscriptText(merged);
  }

  async function transcribeLongAudio(
    audioBlob: Blob,
    model: string,
    language = 'auto',
    fileNameBase = 'audio',
    onProgress?: (current: number, total: number) => void,
    options?: { temperature?: number; preferredEp?: string }
  ): Promise<any> {
    const mono = await getMono16kBuffer(audioBlob);
    const sr = 16000;
    const chunkSec = 28;
    const overlapSec = 4;
    const chunkSamples = Math.floor(chunkSec * sr);
    const step = chunkSamples - Math.floor(overlapSec * sr);
    const total = mono.length;

    const texts: string[] = [];
    let pos = 0;
    let idx = 0;
    const totalChunks = Math.max(1, Math.ceil(total / step));

    while (pos < total) {
      const end = Math.min(pos + chunkSamples, total);
      const len = end - pos;
      if (len < 1000) break; // too short

      const data = new Float32Array(len);
      mono.copyFromChannel(data, 0, pos);

      // Small temp context just to build AudioBuffer for the chunk WAV
      const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const chunkBuf = tmpCtx.createBuffer(1, len, sr);
      chunkBuf.copyToChannel(data, 0);
      try { tmpCtx.close?.(); } catch {}

      const wavBlob = new Blob([audioBufferToWav(chunkBuf)], { type: 'audio/wav' });

      if (onProgress) onProgress(idx + 1, totalChunks);
      statusMessage = `Transcribing segment ${idx + 1} of ${totalChunks}...`;

      try {
        const res = await transcribeAudio(wavBlob, model, language, `${fileNameBase}_part${idx}.wav`, options);
        const t = getTranscriptTextFromResult(res);
        if (t) texts.push(t);
      } catch (e) {
        console.warn('Chunk transcription failed', e);
      }

      pos += step;
      idx++;
    }

    if (onProgress) onProgress(totalChunks, totalChunks);
    return { text: mergeTranscriptChunks(texts) };
  }

  async function getAudioDuration(blob: Blob): Promise<number> {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
      return 0;
    }

    const ctx = new AudioContextClass();
    try {
      const buf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      return decoded.duration;
    } catch (error) {
      console.warn("Failed to determine audio duration", error);
      return 0;
    } finally {
      try {
        await ctx.close();
      } catch (closeError) {
        console.warn("Failed to close AudioContext after duration decode", closeError);
      }
    }
  }

  async function doTranscribe() {
    const sttAlias = effectiveSTTModelAlias || "whisper-tiny";

    if (!audioBlob) {
      statusMessage = "Record or upload audio first.";
      return;
    }

    isTranscribing = true;
    transcription = "";
    statusMessage = `Transcribing with ${sttAlias} via sidecar...`;

    try {
      // Ensure the local service is running with an STT-capable model.
      await startSvc(
        sttAlias,
        selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
      );

      const dur = await getAudioDuration(audioBlob);
      statusMessage = dur > 90
        ? "Normalizing long audio (chunking for full transcription)..."
        : "Normalizing audio to WAV...";

      // The ONNX Runtime GenAI audio decoder used by Foundry Local Whisper models
      // is extremely strict ("Cannot detect audio stream format"). We always
      // decode + re-encode to 16 kHz mono WAV before sending.
      //
      // For long audio we split into overlapping chunks because the model
      // backend often only returns the beginning when given one huge file.
      let result: any;
      if (dur > 90) {
        const estChunks = Math.max(1, Math.ceil(dur / 24));
        transcriptionProgress = { current: 0, total: estChunks };
        statusMessage = "Transcribing long audio in overlapping chunks...";
        result = await transcribeLongAudio(audioBlob, sttAlias, transcriptionLanguage, 'audio', (cur, tot) => {
          transcriptionProgress = { current: cur, total: tot };
          statusMessage = `Transcribing segment ${cur}/${tot}...`;
        }, {
          temperature: 0,
          preferredEp: selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference
        });
      } else {
        let sendBlob = audioBlob;
        let sendName = "audio.webm";
        try {
          sendBlob = await convertAudioBlobToWav(audioBlob);
          sendName = "audio.wav";
        } catch (convErr) {
          console.warn("WAV normalization failed, trying original", convErr);
        }

        result = await transcribeAudio(
          sendBlob,
          sttAlias,
          transcriptionLanguage,
          sendName,
          {
            temperature: 0,
            preferredEp: selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference
          }
        );
      }

      // Extract the most complete text possible.
      // Some results put full transcript in .text, others have segments for long audio.
      const transcribed = getTranscriptTextFromResult(result);
      transcription = transcribed || JSON.stringify(result, null, 2);

      // Helpful for debugging long audio: the backend may return duration or segments
      // even if .text is partial.
      if (result && typeof result.duration === 'number') {
        console.log(`[transcription] model reported audio duration: ${result.duration}s`);
      }
      transcriptionProgress = null;
      const path = result?.transcriptionPath ? ` via ${result.transcriptionPath}` : "";
      statusMessage = dur > 90
        ? `Transcription complete (full long audio via chunks${path})`
        : `Transcription complete (via sidecar${path})`;
    } catch (err: any) {
      transcription = `Error: ${err.message || err}`;
      statusMessage = "Transcription failed";
      transcriptionProgress = null;
    } finally {
      isTranscribing = false;
    }
  }

  async function copyTranscriptionToClipboard() {
    if (!transcription) return;
    try {
      await navigator.clipboard.writeText(transcription);
      statusMessage = "Transcription copied to clipboard";
    } catch (e: any) {
      statusMessage = `Failed to copy transcription: ${e?.message || e}`;
    }
  }

  function downloadTranscription() {
    if (!transcription) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `flint-transcription-${stamp}.txt`;
    const blob = new Blob([transcription], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    statusMessage = `Transcription downloaded: ${fileName}`;
  }
</script>

<main class="app">
  <header class="header">
    <div class="brand" data-tooltip="Foundry Local Interface">
      <img class="brand-logo" src="/favicon.png" alt="Flint logo" />
      <strong>FLInt</strong>
    </div>

    <div class="status-bar">
      {#if state.ready}
        <span class="status ready">● Connected</span>
        {#if state.eps.length}
          <span class="accel" title="Execution providers">
            {state.eps.filter((e) => e.isRegistered).length}/{state.eps.length} accel
          </span>
        {/if}
        {#if selectedModelAlias}
          <span class="current-model" title="Running locally via Foundry Local">
            <Icon name="monitor" size={14} /> {selectedModelAlias}
            <span class="local-badge">local</span>
          </span>
        {/if}
        {#if state.endpoint}
          <span class="endpoint">{state.endpoint}</span>
        {/if}
      {:else if state.error}
        <span class="status error">● {state.error}</span>
      {:else}
        <span class="status">Connecting...</span>
      {/if}

      {#if state.serviceRunning}
        <span class="service-badge running">● Service ON</span>
      {:else if state.ready}
        <button class="tiny" onclick={startLocalService}>Start Service</button>
      {/if}

      <span class="status-msg">{statusMessage}</span>
    </div>

    <div class="header-actions">
      <button onclick={loadModels} disabled={!state.ready || isLoadingModels}>
        {isLoadingModels ? "Refreshing..." : "Refresh Catalog"}
      </button>

      <!-- Theme toggle -->
      <button
        class="theme-toggle"
        onclick={() => theme = theme === 'dark' ? 'light' : 'dark'}
        title="Toggle light/dark mode"
      >
        {#if theme === 'dark'}<Icon name="sun" size={16} />{:else}<Icon name="moon" size={16} />{/if}
      </button>
    </div>
  </header>

  <div class="body">
    <nav class="sidebar" class:collapsed={sidebarCollapsed}>
      <button
        class="nav-item collapse-toggle"
        onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <svg
          class="collapse-icon"
          class:collapsed={sidebarCollapsed}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.8" />
          <path d="M9.5 5.5V18.5" stroke="currentColor" stroke-width="1.8" />
          <path d="M13 8.5H17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path d="M13 12H17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path d="M13 15.5H17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>

      <button
        class="nav-item"
        class:active={currentView === "models"}
        onclick={() => (currentView = "models")}
        title="Models"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 3.5L19 7.5L12 11.5L5 7.5L12 3.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M5 7.5V16.5L12 20.5L19 16.5V7.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M12 11.5V20.5" stroke="currentColor" stroke-width="1.8" />
          </svg>
        </span>
        <span class="nav-label">Models</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "chat"}
        onclick={() => (currentView = "chat")}
        title="Chat"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="5" width="16" height="11" rx="3" stroke="currentColor" stroke-width="1.8" />
            <path d="M9 16L7.5 19.5L12.5 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M8 10.5H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </span>
        <span class="nav-label">Chat</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "audio"}
        onclick={() => (currentView = "audio")}
        title="Audio"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="9" y="4" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.8" />
            <path d="M6.5 11.5C6.5 14.5 8.8 17 12 17C15.2 17 17.5 14.5 17.5 11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M12 17V20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M9.5 20H14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </span>
        <span class="nav-label">Audio</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "diagnostics"}
        onclick={() => (currentView = "diagnostics")}
        title="Diagnostics"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 17L9 13L12 15L16.5 9.5L19 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M4.5 19.5H19.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <circle cx="7.5" cy="8" r="1" fill="currentColor" />
            <circle cx="12" cy="10.5" r="1" fill="currentColor" />
            <circle cx="16.5" cy="6.5" r="1" fill="currentColor" />
          </svg>
        </span>
        <span class="nav-label">Diagnostics</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "monitor"}
        onclick={() => { currentView = "monitor"; refreshMonitorNow(); }}
        title="Monitor"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8" />
            <path d="M8 20H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M12 17V20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M7 12.5L9.5 10L12 12L15 8.5L17 10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="nav-label">Monitor</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "compare"}
        onclick={() => (currentView = "compare")}
        title="Compare models side-by-side"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="4" width="7" height="16" rx="1" stroke="currentColor" stroke-width="1.6"/>
            <rect x="14" y="4" width="7" height="16" rx="1" stroke="currentColor" stroke-width="1.6"/>
          </svg>
        </span>
        <span class="nav-label">Compare</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "integrations"}
        onclick={() => (currentView = "integrations")}
        title="Integrations"
      >
        <span class="nav-icon" aria-hidden="true">
          <Icon name="zap" size={20} />
        </span>
        <span class="nav-label">Integrations</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "learn"}
        onclick={() => (currentView = "learn")}
        title="Learn"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4.5 6.5C4.5 5.4 5.4 4.5 6.5 4.5H11V19.5H6.5C5.4 19.5 4.5 18.6 4.5 17.5V6.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M19.5 6.5C19.5 5.4 18.6 4.5 17.5 4.5H13V19.5H17.5C18.6 19.5 19.5 18.6 19.5 17.5V6.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="nav-label">Learn</span>
      </button>

      <button
        class="nav-btn"
        class:active={currentView === "settings"}
        onclick={() => (currentView = "settings")}
        title="Settings"
      >
        <span class="nav-icon" aria-hidden="true">
          <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.8"/>
            <path d="M10.29 3.86 8.64 4.86l.26 1.5A6.8 6.8 0 0 0 7.4 7.4L5.9 7.14l-1 1.72 1.07 1.08A6.7 6.7 0 0 0 5.86 12a6.7 6.7 0 0 0 .11 1.06L4.9 14.14l1 1.72 1.5-.26c.36.37.77.7 1.22.98l-.26 1.5 1.72 1L10.86 18c.37.09.75.14 1.14.14.39 0 .77-.05 1.14-.14l.68.98 1.72-1-.26-1.5c.45-.28.86-.61 1.22-.98l1.5.26 1-1.72-1.07-1.08c.07-.35.11-.7.11-1.06 0-.36-.04-.71-.11-1.06l1.07-1.08-1-1.72-1.5.26A6.8 6.8 0 0 0 16.1 7.4l.26-1.5-1.72-1-.68.98A6.8 6.8 0 0 0 12 5.86c-.39 0-.77.05-1.14.14l-.57-.14Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="nav-label">Settings</span>
      </button>

      <div class="sidebar-footer">
        <div class="privacy">On-device inference</div>
      </div>
    </nav>

    <section class="content">
      {#if currentView === "models"}
        <div class="view models-view">
          <h2>Model Catalog</h2>

          {#if !state.ready}
            <div class="notice">
              <p>
                <strong
                  >Starting sidecar + bundled Foundry Local runtime...</strong
                >
              </p>
              <p>
                The runtime is bundled. The sidecar handles model management and
                the local service.
              </p>
              <button onclick={init}>Retry</button>
            </div>
          {:else}
            <div class="toolbar">
              <input
                type="text"
                placeholder="Search models (alias or family)..."
                bind:value={searchTerm}
              />
              <span class="count">{filteredModels.length} models</span>
            </div>

            <div class="accel-panel">
              <div class="accel-panel-row">
                <label for="accel-pref">Preferred acceleration</label>
                <select
                  id="accel-pref"
                  bind:value={selectedAccelerationPreference}
                  onchange={(e) =>
                    setAccelerationPreference(
                      (e.currentTarget as HTMLSelectElement).value,
                    )}
                >
                  <option value="auto">Auto (runtime decides)</option>
                  {#each state.eps as ep (ep.name)}
                    <option value={ep.name}>
                      {ep.name} {ep.isRegistered ? "• ready" : "• detected"}
                    </option>
                  {/each}
                </select>
                <button onclick={ensureHardwareAccel} disabled={!state.ready}>
                  Install / Update Accelerators
                </button>
                <button class="secondary" onclick={refreshExecutionProviders} disabled={!state.ready}>
                  Recheck Providers
                </button>
              </div>
              {#if state.eps.length}
                <div class="ep-status-list">
                  {#each state.eps as ep (ep.name)}
                    <span class="ep-pill" class:ready={ep.isRegistered}>
                      {ep.name} • {ep.isRegistered ? "ready" : "not ready"}
                    </span>
                  {/each}
                </div>
              {/if}
            </div>

            {#if recommendedStarters.length > 0}
              <div class="recommendations">
                <h3>Recommended for your hardware</h3>
                <div class="hardware-info">
                  {state.eps.length} execution providers detected • {state.eps.filter(
                    (e) => e.isRegistered,
                  ).length} ready
                  {#if state.acceleratorsReady}
                    (accelerated){/if}
                  • preference:
                  {selectedAccelerationPreference === "auto"
                    ? "auto"
                    : selectedAccelerationPreference}
                </div>
                <div class="starter-options">
                  {#each recommendedStarters as model (model.alias)}
                    <div class="starter-card">
                      <div>
                        <strong>{model.alias}</strong>
                        {#if (model as any).info?.fileSizeMb}
                          <span class="size"
                            >~{(model as any).info.fileSizeMb} MB</span
                          >
                        {/if}
                      </div>
                      <div class="actions">
                        <button
                          onclick={() => useStarterModel(model)}
                          disabled={isLoadingRecommendations}
                        >
                          {#if !model.isCached}
                            Download & Start
                          {:else if !model.isLoaded}
                            Load & Use
                          {:else}
                            Use Now
                          {/if}
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
                <small
                  >Hardware-aware small models (1-3 options). Pick one to get
                  started quickly.</small
                >
                {#if recommendedStarters.length > 0 && !recommendedStarters.some((m) => m.isCached || m.isLoaded)}
                  <div style="margin-top:8px">
                    <button
                      onclick={() => useStarterModel(recommendedStarters[0])}
                    >
                      Quick Start with {recommendedStarters[0].alias}
                    </button>
                  </div>
                {/if}
              </div>
            {/if}

            {#if state.pool?.length}
              <div class="pool-panel">
                <div class="pool-panel-header">
                  <h3>Running ({state.pool.length} model{state.pool.length !== 1 ? 's' : ''})</h3>
                  {#if state.poolStats}
                    <span class="pool-mem">
                      {state.poolStats.usedMemMb} MB used &nbsp;·&nbsp; {state.poolStats.freeMemMb} MB free of {state.poolStats.totalMemMb} MB
                    </span>
                  {/if}
                </div>
                <div class="pool-table">
                  {#each state.pool as entry (entry.alias)}
                    {@const shortVariant = entry.variantId?.split(':')[0]?.split('-').slice(-3).join('-') ?? '—'}
                    {@const tokens = state.poolStats?.tokenTotals?.find((t) => t.alias === entry.alias)}
                    <div class="pool-row">
                      <span class="pool-alias">{entry.alias}</span>
                      <span class="pool-variant" title={entry.variantId}>{shortVariant}</span>
                      <span class="badge" class:loaded={entry.isLoaded === true} class:warn={entry.isLoaded === false}>
                        {entry.isLoaded === true ? 'Loaded' : entry.isLoaded === false ? 'Evicted' : 'Active'}
                      </span>
                      {#if tokens}
                        <span class="pool-tokens" title="Session tokens in / out">↑{tokens.tokensIn} ↓{tokens.tokensOut}</span>
                      {/if}
                      <button class="small danger-btn" onclick={() => unloadModel({ alias: entry.alias })}>Unload</button>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            {#if isLoadingModels && state.models.length === 0}
              <p>Loading catalog...</p>
            {:else}
              <div class="model-grid">
                {#each filteredModels as model (model.alias)}
                  <div class="model-card">
                    <div class="model-header">
                      <strong title={getShortModelDescription(model)}>
                        {model.alias}
                      </strong>
                      <span class="badges">
                        {#if model.isCached}<span class="badge cached"
                            >Downloaded</span
                          >{/if}
                        {#if model.isLoaded}<span class="badge loaded"
                            >Loaded</span
                          >{/if}
                      </span>
                    </div>

                    <div class="model-meta">
                      <span title="Model file size (reported by catalog)">Size: {formatSizeLabel(model)}</span>
                      <span title="Estimated in-memory runtime footprint for local inference">
                        Memory: {estimateMemoryRequirement(model)}
                      </span>
                      {#if getFamilyLabel(model)}
                        <span>
                          Family:
                          <span class="meta-badges">
                            <span class="meta-badge">{getFamilyLabel(model)}</span>
                          </span>
                        </span>
                      {/if}
                      <span title="Execution providers currently applicable on this machine">
                        Acceleration:
                        <span class="meta-badges">
                          {#each getApplicableAccelerationLabels(model, state.eps, hostPlatform) as accel}
                            <span class="meta-badge">{accel}</span>
                          {/each}
                        </span>
                      </span>
                      {#if model.isCached}
                        <span title="What is currently downloaded for this model">
                          Downloaded artifact:
                          <span class="meta-badges">
                            <span class="meta-badge">Model weights</span>
                          </span>
                        </span>
                        <span>Downloaded at: {formatMetaTimestamp(modelRuntimeMeta[model.alias]?.downloadedAt)}</span>
                        <span>Last used acceleration: {modelRuntimeMeta[model.alias]?.lastUsedAcceleration || "Unknown"}</span>
                      {/if}
                      {#if normalizeCapabilities(model).length}
                        <span>
                          Capabilities:
                          <span class="meta-badges">
                            {#each normalizeCapabilities(model) as cap}
                              <span class="meta-badge">{cap}</span>
                            {/each}
                          </span>
                        </span>
                      {/if}
                      <span class="model-short-desc" title={getShortModelDescription(model)}>
                        {getShortModelDescription(model)}
                      </span>
                    </div>

                    {#if (model as any).variants?.length > 0}
                      <div class="variant-section">
                        <button
                          class="variant-toggle"
                          onclick={() => { variantPanelOpen[model.alias] = !variantPanelOpen[model.alias]; }}
                        >
                          {#if (model as any).variants.length === 1}
                            1 variant
                          {:else}
                            {(model as any).variants.length} variants
                          {/if}
                          &nbsp;{variantPanelOpen[model.alias] ? '▲' : '▼'}
                        </button>
                        {#if variantPanelOpen[model.alias]}
                          <div class="variant-list">
                            {#each (model as any).variants as variant (variant.id)}
                              {@const isCurrentlyLoaded = state.pool.some((e) => e.variantId === variant.id)}
                              {@const badge = accelBadgeInfo(variant.deviceType, variant.executionProvider)}
                              <div class="variant-row" class:variant-active={isCurrentlyLoaded}>
                                <span class="accel-badge {badge.cls}">{badge.label}</span>
                                {#if variant.fileSizeMb}
                                  <span class="variant-size">{Math.round(variant.fileSizeMb)} MB</span>
                                {/if}
                                {#if variant.cached}
                                  <span class="badge small cached">Downloaded</span>
                                {/if}
                                {#if isCurrentlyLoaded}
                                  <span class="badge small loaded">Running</span>
                                {:else if variant.cached}
                                  <button class="small" onclick={() => loadVariant(model, variant.id)}>Load</button>
                                {:else}
                                  <button class="small" onclick={() => downloadVariant(model, variant.id)} disabled={downloadingVariantIds[variant.id]}>
                                    {downloadingVariantIds[variant.id] ? 'Downloading…' : 'Download'}
                                  </button>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        {/if}
                      </div>
                    {/if}

                    <div class="model-actions">
                      {#if selectedModelAlias === model.alias}
                        <span class="current-badge">CURRENT</span>
                      {/if}

                      {#if !model.isCached}
                        <button onclick={() => downloadAndTrack(model)} disabled={downloadingModelAliases[model.alias]}>
                          {downloadingModelAliases[model.alias] ? 'Downloading…' : 'Download'}
                        </button>
                      {/if}

                      {#if model.isCached && !model.isLoaded}
                        <button onclick={() => loadModelAndMaybeStart(model)}
                          >Load</button
                        >
                        {#if modelSupportsChat(model)}
                          <button onclick={() => loadAndSelect(model)}
                            >Load & Chat</button
                          >
                        {/if}
                      {/if}

                      {#if model.isLoaded}
                        {#if selectedModelAlias !== model.alias}
                          {#if modelSupportsChat(model)}
                            <button onclick={() => selectAndChat(model)}
                              >Chat with this</button
                            >
                          {/if}
                        {/if}
                        <button onclick={() => unloadModel(model)}
                          >Unload</button
                        >
                      {/if}

                      {#if model.isCached && model.isLoaded && selectedModelAlias !== model.alias}
                        {#if modelSupportsChat(model)}
                          <button
                            onclick={() => selectAndChat(model)}
                            class="primary-chat">Set as Current Chat</button
                          >
                        {/if}
                      {/if}

                      {#if modelSupportsAudio(model)}
                        <button onclick={() => useSTTModelForAudio(model)} class="stt-btn">Use for Audio</button>
                      {/if}

                      {#if model.isCached}
                        <button class="danger-btn" onclick={() => deleteCachedModel(model)}>Delete</button>
                      {/if}

                      <label class="startup-toggle" title="Load this model automatically when Flint starts">
                        <input
                          type="checkbox"
                          checked={startupModels[model.alias] !== undefined}
                          onchange={() => toggleStartup(model.alias, null)}
                        />
                        Load on startup{#if startupModels[model.alias]}&nbsp;<span class="startup-variant-hint">({startupModels[model.alias]?.split(':')[0]?.split('-').slice(-2).join('-')})</span>{/if}
                      </label>

                      <button
                        class="secondary"
                        onclick={() => (modelDetailsAlias = model.alias)}
                      >
                        Details
                      </button>
                    </div>
                  </div>
                {/each}
              </div>

              {#if modelDetailsAlias}
                {@const detailModel = state.models.find((m: any) => m.alias === modelDetailsAlias)}
                {#if detailModel}
                  <div
                    class="model-modal-overlay"
                    role="presentation"
                    onclick={() => (modelDetailsAlias = null)}
                    onkeydown={(e) => { if (e.key === 'Escape') modelDetailsAlias = null; }}
                  >
                    <div
                      class="model-modal"
                      role="dialog"
                      aria-modal="true"
                      aria-label={`${detailModel.alias} details`}
                      tabindex="-1"
                      onclick={(e) => e.stopPropagation()}
                      onkeydown={(e) => { if (e.key === 'Escape') modelDetailsAlias = null; }}
                    >
                      <div class="modal-header">
                        <h3>{detailModel.alias}</h3>
                        <button type="button" aria-label="Close model details" onclick={() => (modelDetailsAlias = null)}><Icon name="x" size={14} /></button>
                      </div>
                      <div class="modal-body model-detail-grid">
                        <div><strong>Task:</strong> {(detailModel as any).task || (detailModel as any).info?.task || "Unknown"}</div>
                        <div><strong>Family:</strong> {(detailModel as any).family || (detailModel as any).info?.family || "Unknown"}</div>
                        <div><strong>Size:</strong> {formatSizeLabel(detailModel)}</div>
                        <div><strong>Estimated memory:</strong> {estimateMemoryRequirement(detailModel)}</div>
                        <div><strong>Context:</strong> {formatContextLength(detailModel)}</div>
                        <div><strong>Downloaded artifact:</strong> {detailModel.isCached ? "Model weights" : "Not downloaded"}</div>
                        <div><strong>Downloaded at:</strong> {formatMetaTimestamp(modelRuntimeMeta[detailModel.alias]?.downloadedAt)}</div>
                        <div><strong>Last used acceleration:</strong> {modelRuntimeMeta[detailModel.alias]?.lastUsedAcceleration || "Unknown"}</div>
                        <div>
                          <strong>Applicable accelerations:</strong>
                          <span class="meta-badges">
                            {#each getApplicableAccelerationLabels(detailModel, state.eps, hostPlatform) as accel}
                              <span class="meta-badge">{accel}</span>
                            {/each}
                          </span>
                        </div>
                        <div>
                          <strong>Capabilities:</strong>
                          {#if normalizeCapabilities(detailModel).length}
                            <span class="meta-badges">
                              {#each normalizeCapabilities(detailModel) as cap}
                                <span class="meta-badge">{cap}</span>
                              {/each}
                            </span>
                          {:else}
                            Unknown
                          {/if}
                        </div>
                        <div><strong>Acceleration fit:</strong> {describeAccelerationFit(detailModel, selectedAccelerationPreference)}</div>
                        <div>
                          <strong>Description:</strong>
                          {getShortModelDescription(detailModel)}
                        </div>
                        {#if hostPlatform === "macos"}
                          <div class="small">
                            macOS note: Apple GPU acceleration depends on CoreML/Metal provider availability in your local runtime.
                          </div>
                        {/if}
                      </div>
                      <div class="modal-footer">
                        <span class="small">
                          Memory and acceleration values are guidance estimates for local planning.
                        </span>
                      </div>
                    </div>
                  </div>
                {/if}
              {/if}
            {/if}
          {/if}
        </div>
      {:else if currentView === "chat"}
        <div class="view chat-view">
          <div class="chat-container">
            <ConversationSidebar
              {conversations}
              {currentConversationId}
              onNewChat={createNewConversation}
              onSelectConversation={selectConversation}
              onDeleteConversation={deleteConversation}
            />

            <div class="chat-main">
              {#if chatBlockedByLoadedSTT}
                <div class="notice" style="margin: 12px; padding: 12px;">
                  <strong>{loadedAudioModel?.alias}</strong> is currently active for audio transcription.
                  Text chat is temporarily disabled. Load a chat model from the Models view to continue.
                </div>
              {:else if !selectedModelSupportsChat}
                <div class="notice" style="margin: 12px; padding: 12px;">
                  <strong>{selectedModelAlias}</strong> is an STT/audio-only model and does not support chat completions.
                  Use the Audio tab or select a chat model from the Models view.
                </div>
              {/if}
              <div class="chat-header">
                <h2>Chat with {selectedModelAlias || "model"}</h2>
                <button
                  type="button"
                  class="compact-btn full-thread-btn"
                  onclick={() => (showFullHistory = !showFullHistory)}
                  title="Toggle between compact (recommended for inference) and full uncondensed thread"
                >
                  {#if showFullHistory}<Icon name="scroll" size={13} /> Compact{:else}<Icon name="book" size={13} /> Full thread{/if}
                </button>

                {#if chatMessages.length > contextTurns * 2 + 4}
                  <button
                    type="button"
                    class="compact-btn"
                    title="Mark older messages as condensed (they stay in full thread view)"
                    onclick={() => {
                      // Non-destructive: mark old non-pinned as condensed instead of deleting
                      const keep = contextTurns * 2;
                      const toCondense = chatMessages.slice(0, -keep).filter((m: any) => !m.pinned && !m.isSummary);
                      toCondense.forEach((m: any) => { m.condensed = true; });
                      chatMessages = [...chatMessages];
                      statusMessage = `Older messages condensed (view full thread to read them)`;
                    }}
                  >
                    Condense old
                  </button>
                  <button
                    type="button"
                    class="compact-btn summarize-btn"
                    title="Use the model to summarize older turns into a compact memory note. Allows continuing long chats efficiently."
                    disabled={isStreaming}
                    onclick={() => compactConversationWithSummary(Math.max(4, Math.floor(contextTurns / 2)))}
                  >
                    Summarize &amp; Compact
                  </button>
                {/if}
                {#if selectedModelAlias}
                  <button
                    onclick={() => (currentView = "models")}
                    class="secondary small">Change Model</button
                  >
                {/if}
              </div>

              <div class="messages" bind:this={messagesContainer}>
                {#if chatMessages.length === 0}
                  <div class="empty-chat">
                    Start a conversation. Your model is ready locally.
                  </div>
                {:else}
                  {#each chatMessages as msg, i}
                    {#if showFullHistory || !msg.condensed || msg.isSummary}
                      <div class="message {msg.role}" class:summary={!!msg.isSummary} class:pinned={!!msg.pinned} class:condensed={msg.condensed && !showFullHistory}>
                        <div class="role">
                          {#if msg.isSummary}<Icon name="note" size={15} />{:else if msg.role === "user"}<Icon name="user" size={15} />{:else}<Icon name="bot" size={15} />{/if}
                          {#if msg.role !== 'system'}
                            <button
                              type="button" aria-label={msg.pinned ? "Unpin message" : "Pin message"}
                              class="pin-btn"
                              class:pinned={!!msg.pinned}
                              title={msg.pinned ? "Unpin (this message will be subject to normal trimming)" : "Pin this message — it will always be included in context"}
                              onclick={() => {
                                msg.pinned = !msg.pinned;
                                chatMessages = [...chatMessages]; // force update
                              }}
                            >
                              <Icon name={msg.pinned ? "pin" : "pin-off"} size={13} />
                            </button>
                          {/if}
                        </div>
                        <div class="content">
                          {#if msg.isSummary}
                            <div class="summary-label">Conversation memory</div>
                          {/if}
                          {#if msg.condensed && !showFullHistory}
                            <div class="condensed-hint">(condensed — switch to full thread to read)</div>
                          {/if}
                          <MessageRenderer
                            content={msg.content}
                            role={msg.role}
                          />
                        </div>
                      </div>
                    {/if}
                  {/each}
                {/if}
                {#if isStreaming}
                  <div class="message assistant streaming">
                    <div class="role"><Icon name="bot" size={15} /></div>
                    <div class="content">
                      <span class="typing-indicator"></span>
                    </div>
                  </div>
                {/if}
              </div>

              <div class="chat-controls">
                <!-- Persona selector (replaces direct system prompt input) -->
                <div class="persona-control">
                  {#if currentPersonaName}
                    <span class="persona-chip" title="Active persona">{currentPersonaName}</span>
                  {/if}
                  <button
                    type="button"
                    class="persona-btn"
                    title="Choose persona (system prompt preset)"
                    disabled={isStreaming}
                    bind:this={personaBtnEl}
                    onclick={() => {
                      const next = !showPersonaMenu;
                      showPersonaMenu = next;
                      if (next) queueMicrotask(positionPersonaMenu);
                    }}
                  >
                    <Icon name="masks" size={16} label="Choose persona" />
                  </button>

                  {#if showPersonaMenu}
                    <div
                      class="persona-menu"
                      class:up={personaMenuDirection === 'up'}
                      role="menu"
                      tabindex="-1"
                      style="position: fixed; top: {personaMenuPos.top}px; left: {personaMenuPos.left}px;"
                    >
                      <div class="persona-menu-header">
                        Choose persona
                        <span class="hint">({currentModelTags.join(", ")} model)</span>
                      </div>
                      <div class="persona-menu-items">
                        {#each sortedPersonasForUI as p (p.id)}
                          <button
                            type="button"
                            class="persona-item"
                            class:matches={scorePersonaForModel(p, currentModelTags) > 1.5}
                            onclick={() => {
                              systemPrompt = p.prompt;
                              showPersonaMenu = false;
                              statusMessage = `Persona: ${p.name}`;
                            }}
                          >
                            <span class="p-name">{p.name}</span>
                            {#if p.description}
                              <span class="p-desc">{p.description}</span>
                            {/if}
                            {#if p.tags?.length}
                              <span class="p-tags">{p.tags.join(" ")}</span>
                            {/if}
                          </button>
                        {/each}
                      </div>
                      <div class="persona-menu-footer">
                        <button type="button" class="manage-link" onclick={() => { showPersonaMenu = false; showPersonaManager = true; }}>
                          Manage personas…
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>

                <!-- Context management -->
                <div class="context-control">
                  <label for="ctx-select" title="Context window for this model">Ctx</label>
                  <select
                    id="ctx-select"
                    bind:value={contextTurns}
                    title={`Keep last N turns. Model context: ${currentModelContextLength ? currentModelContextLength + ' tokens' : 'unknown'}. Lower = faster & lower energy.`}
                    disabled={isStreaming}
                  >
                    <option value={4}>4 turns</option>
                    <option value={8}>8 turns</option>
                    <option value={12}>12 turns</option>
                    <option value={20}>20 turns</option>
                    <option value={30}>30 turns</option>
                  </select>
                  <span
                    class="context-estimate"
                    title="Estimated tokens being sent this turn (rough). Smaller = less time & energy."
                  >
                    ~{estimatedContextTokens}t
                    {#if contextUsagePercent !== null}
                      <span class="usage-pct" class:high={contextUsagePercent > 70}>({contextUsagePercent}%)</span>
                    {/if}
                  </span>
                  {#if currentModelContextLength}
                    <span class="context-model-info" title="Model's reported context window">
                      / ~{Math.round(currentModelContextLength / 1024)}k
                    </span>
                    {#if recommendedMaxTurns && Math.abs(contextTurns - recommendedMaxTurns) > 1}
                      <button
                        type="button"
                        class="recommend-btn"
                        onclick={applyRecommendedContext}
                        title={`Use recommended ${recommendedMaxTurns} turns for this model`}
                      >rec</button>
                    {/if}
                  {/if}

                  <!-- Usage meter -->
                  {#if contextUsagePercent !== null}
                    <div class="context-meter" title="Approximate % of model context used by current trimmed history">
                      <div class="meter-bar">
                        <div
                          class="meter-fill"
                          style="width: {contextUsagePercent}%"
                          class:warn={contextUsagePercent > 70}
                          class:danger={contextUsagePercent > 85}
                        ></div>
                      </div>
                    </div>
                    {#if contextUsagePercent > 70}
                      <span class="context-warn" title="High context usage may slow responses and use more power. Consider trimming, summarizing, or lowering turns.">
                        <Icon name="warning" size={13} /> High
                      </span>
                    {/if}
                  {/if}
                </div>

                {#if isVisionModel}
                  <div class="vision-attach">
                    <button
                      type="button"
                      onclick={attachImage}
                      disabled={isStreaming || attachedImages.length >= 4}
                      title="Attach up to 4 images (vision models only)"
                    >
                      <Icon name="camera" size={14} /> Image ({attachedImages.length}/4)
                    </button>
                    {#if attachedImages.length > 0}
                      <div class="image-strip">
                        {#each attachedImages as img, i (i)}
                          <span class="thumb">
                            <img src={img} alt="attached" />
                            <button type="button" onclick={() => removeImage(i)} class="mini" title="Remove image">
                              <Icon name="x" size={10} />
                            </button>
                          </span>
                        {/each}
                      </div>
                      <button type="button" onclick={clearImages} class="mini">Clear all</button>
                    {/if}
                  </div>
                {/if}
              </div>

              {#if isDictating || dictationInterim}
                <div class="dictation-preview">
                  <span class="dictation-indicator" class:pulsing={isDictating}><Icon name="mic" size={14} /></span>
                  {#if dictationInterim}
                    <span class="dictation-interim">{dictationInterim}</span>
                  {:else}
                    <span class="dictation-hint">Listening…</span>
                  {/if}
                </div>
              {/if}

              <form class="chat-input" onsubmit={sendMessage} ondrop={handleDrop} ondragover={handleDragOver} ondragenter={handleDragOver}>
                {#if chatBlockedByLoadedSTT}
                  <div style="width:100%; padding: 8px; font-size:0.8rem; color:var(--muted);">
                    Text chat is disabled while STT model <strong>{loadedAudioModel?.alias}</strong> is active.
                  </div>
                {:else if !selectedModelSupportsChat}
                  <div style="width:100%; padding: 8px; font-size:0.8rem; color:var(--muted);">Chat disabled for current model.</div>
                {/if}
                <button
                  type="button"
                  class="dictation-btn"
                  class:active={isDictating}
                  onclick={toggleDictation}
                  title={isDictating ? "Stop dictation (finalizes transcript)" : "Dictate into chat (requires STT model)"} aria-label={isDictating ? "Stop dictation" : "Start dictation"}
                  disabled={isStreaming}
                >
                  {#if isDictating}<Icon name="stop" size={14} />{:else}<Icon name="mic" size={14} />{/if}
                </button>
                <input
                  bind:value={chatInput}
                  placeholder={isDictating ? "Dictating… (click Stop to finish)" : "Type your message... (model is running locally)"}
                  disabled={chatBlockedByLoadedSTT || !selectedModelSupportsChat || (!state.endpoint && !chatClient) || isStreaming}
                  onkeydown={(e) => { if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendMessage(e); } }}
                  onpaste={handlePaste}
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={chatBlockedByLoadedSTT || !selectedModelSupportsChat || !chatInput.trim() || (!state.endpoint && !chatClient) || isStreaming}
                >
                  {#if isStreaming}<Icon name="loader" size={15} class="spin" />{:else}<Icon name="send" size={15} />{/if}
                </button>
                {#if isStreaming}
                  <button type="button" onclick={stopGeneration} class="stop"
                    ><Icon name="stop" size={14} /> Stop</button
                  >
                {/if}
              </form>

              <!-- Persona Manager Modal -->
              {#if showPersonaManager}
                <div
                  class="persona-modal-overlay"
                  role="presentation"
                  onclick={closePersonaManager}
                  onkeydown={(e) => { if (e.key === 'Escape') closePersonaManager(); }}
                >
                  <div
                    class="persona-modal"
                    role="dialog"
                    aria-modal="true"
                    tabindex="-1"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => { if (e.key === 'Escape') closePersonaManager(); }}
                  >
                    <div class="modal-header">
                      <h3>Manage Personas</h3>
                      <button type="button" aria-label="Close persona manager" onclick={closePersonaManager}><Icon name="x" size={14} /></button>
                    </div>

                    <div class="modal-body">
                      <p class="small">Predefined personas are built-in. Your custom ones are saved locally.</p>

                      <h4>Current personas</h4>
                      <div class="persona-list-manage">
                        {#each allPersonas as p}
                          <div class="persona-row">
                            <div>
                              <strong>{p.name}</strong>
                              {#if p.description}<span class="small"> — {p.description}</span>{/if}
                              <div class="small mono">{p.prompt.slice(0, 80)}{p.prompt.length > 80 ? "…" : ""}</div>
                            </div>
                            <div class="persona-row-actions">
                              <button type="button" onclick={() => { choosePersona(p); }}>Use</button>
                              <button type="button" onclick={() => startEditPersona(p)}>Edit</button>
                              {#if !PREDEFINED_PERSONAS.some((pp) => pp.id === p.id)}
                                <button type="button" class="danger" onclick={() => deleteCustomPersona(p.id)}>Delete</button>
                              {/if}
                            </div>
                          </div>
                        {/each}
                      </div>

                      <h4>{editingPersona ? "Edit persona" : "Add custom persona"}</h4>
                      <div class="add-form">
                        <input
                          bind:value={managerNewName}
                          placeholder="Name (e.g. My Coding Expert)"
                        />
                        <textarea
                          bind:value={managerNewPrompt}
                          placeholder="You are ... (the full system prompt)"
                          rows="3"
                        ></textarea>
                        <div class="form-actions">
                          <button type="button" onclick={saveEditedPersona}>
                            {editingPersona ? "Save changes" : "Add & Use"}
                          </button>
                          {#if !editingPersona}
                            <button type="button" onclick={addNewPersonaQuick}>Add</button>
                          {/if}
                          <button type="button" onclick={() => { editingPersona = null; managerNewName=""; managerNewPrompt=""; }}>Clear</button>
                        </div>
                      </div>
                    </div>

                    <div class="modal-footer">
                      <button type="button" onclick={closePersonaManager}>Close</button>
                      <span class="small">Personas affect the system message sent with every chat turn.</span>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {:else if currentView === "audio"}
        <div class="view audio-view">
          <h2>Audio Transcription</h2>

          <p class="notice">
            Audio uses STT models (Whisper etc.) via the sidecar + local service.
            Selecting one here will (re)start the service with that model.
            Chat and audio share one endpoint, so only one model is active at a time.
            New STT families appear automatically from catalog metadata (task/capabilities).
            <br><small>For best results on long/complex audio (e.g. Text readings with names), use the largest STT model your hardware supports. Tiny models often hallucinate or repeat words.</small>
          </p>

          <!-- STT model selector (independent of chat selectedModelAlias) -->
          <div class="stt-picker">
            <strong>Current STT model:</strong>
            <span class="current-stt">{effectiveSTTModelAlias || "(none)"}</span>
            {#if effectiveSTTModelAlias}
              <button
                class="tiny"
                onclick={async () => {
                  await startSvc(
                    effectiveSTTModelAlias,
                    selectedAccelerationPreference === "auto" ? undefined : selectedAccelerationPreference,
                  );
                  statusMessage = `Service ensured with ${effectiveSTTModelAlias}`;
                }}
              >
                Ensure service
              </button>
            {/if}

          </div>

          {#if sttModels.length > 0}
            <div class="stt-models">
              <strong>Available STT models:</strong>
              {#each sttModels as m}
                <button
                  onclick={() => useSTTModelForAudio(m)}
                  class="stt-btn"
                  title={m.alias}
                >
                  {m.alias}
                  {#if !m.isCached}(get){/if}
                </button>
              {/each}
            </div>
          {:else}
            <p class="small">No STT models found yet. Make sure the sidecar is initialized and refresh the catalog.</p>
          {/if}

          <div class="audio-controls">
            <label class="audio-language">
              Language
              <select bind:value={transcriptionLanguage} disabled={isTranscribing}>
                <option value="auto">Auto</option>
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="ja">Japanese</option>
                <option value="zh">Chinese</option>
              </select>
            </label>
            <button onclick={toggleRecording} disabled={isTranscribing}>
              {#if isRecording}<Icon name="stop" size={14} /> Stop Recording{:else}<Icon name="mic" size={14} /> Start Recording{/if}
            </button>
            <button onclick={uploadAudioFile} disabled={isTranscribing}>
              <Icon name="folder" size={14} /> Upload Audio File
            </button>
            <button
              onclick={doTranscribe}
              disabled={!audioBlob || isTranscribing || !effectiveSTTModelAlias}
            >
              {isTranscribing
                ? (transcriptionProgress
                    ? `Transcribing ${transcriptionProgress.current}/${transcriptionProgress.total}...`
                    : "Transcribing...")
                : "Transcribe"}
            </button>
          </div>

          {#if audioBlob}
            <div class="audio-info">
              Audio ready ({(audioBlob.size / 1024).toFixed(1)} KB)
              {#await getAudioDuration(audioBlob) then secs}
                — approx {secs.toFixed(1)} seconds
              {/await}
            </div>
          {/if}

          {#if transcription}
            <div class="transcription-result">
              <h3>Transcription:</h3>
              <pre>{transcription}</pre>
              <div class="transcription-actions">
                <button onclick={copyTranscriptionToClipboard}>Copy</button>
                <button onclick={downloadTranscription}>Download .txt</button>
                <button
                  onclick={() => {
                    transcription = "";
                  }}>Clear</button
                >
              </div>
            </div>
          {/if}
        </div>
      {:else if currentView === "diagnostics"}
        <div class="view">
          <h2>Service & Diagnostics</h2>

          <div class="service-panel">
            <h3>Local OpenAI-Compatible Service</h3>
            <div class="status-row">
              <span>Status:</span>
              <span
                class={state.serviceRunning ? "status running" : (
                  "status stopped"
                )}
              >
                {state.serviceRunning ? "RUNNING" : "STOPPED"}
              </span>
            </div>
            {#if state.endpoint}
              <div class="endpoint-display">
                <code>{state.endpoint}</code>
                <button
                  onclick={() =>
                    navigator.clipboard.writeText(state.endpoint || "")}
                  >Copy</button
                >
              </div>
            {/if}

            <div class="service-actions">
              <button
                onclick={startLocalService}
                disabled={state.serviceRunning || !state.ready}
              >
                Start Service
              </button>
              <button
                onclick={stopLocalService}
                disabled={!state.serviceRunning}
              >
                Stop Service
              </button>
              <button onclick={refreshServiceStatus} disabled={!state.ready}>
                Refresh Status
              </button>
              <button onclick={copyDiagnosticsToClipboard}>
                Copy All Diagnostics
              </button>
            </div>
          </div>

          <div class="log-viewer">
            <div class="log-viewer-header">
              <h4>Diagnostic Log <span class="log-count">({sidecarLogs.length})</span></h4>
              <div class="log-actions">
<button class="secondary" onclick={async () => {
  const text = sidecarLogs.map(e => {
    const d = new Date(e.ts);
    const t = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    return `[${t}][${e.source}][${e.level}] ${e.message}`;
  }).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    statusMessage = 'Logs copied to clipboard';
  } catch (e) {
    statusMessage = `Failed to copy logs: ${e}`;
  }
}}>Copy Logs</button>
                <button class="secondary" onclick={() => (sidecarLogs = [])}>Clear</button>
              </div>
            </div>
            <div class="log-list" bind:this={logListEl} use:autoScrollLog>
              {#each sidecarLogs as entry, i (entry.ts + ':' + i)}
                {@const d = new Date(entry.ts)}
                {@const hms = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`}
                <div class="log-entry log-{entry.level}">
                  <span class="log-ts">{hms}</span>
                  <span class="log-src">{entry.source}</span>
                  <span class="log-level">{entry.level}</span>
                  <span class="log-msg">{entry.message}</span>
                </div>
              {:else}
                <div class="log-empty">No log entries yet. Start the service or load a model.</div>
              {/each}
            </div>
          </div>
        </div>
      {:else if currentView === "monitor"}
        <div class="view monitor-view">
          <div class="monitor-header">
            <h2>Monitor</h2>
            <button class="small" onclick={refreshMonitorNow} title="Refresh now">↺ Refresh</button>
          </div>

          <!-- Streaming indicator -->
          {#if state.poolStats?.streaming?.active}
            {@const s = state.poolStats.streaming}
            <div class="stream-indicator">
              <span class="stream-pulse"></span>
              {s.count > 1 ? `${s.count} streams active` : `Streaming${s.modelAlias ? ` · ${s.modelAlias}` : ''}${s.type ? ` · ${s.type}` : ''}`}
              {#if s.elapsedMs != null}
                <span class="stream-elapsed">{(s.elapsedMs / 1000).toFixed(1)}s</span>
              {/if}
            </div>
          {/if}

          <!-- System RAM gauge -->
          {#if state.poolStats}
            {@const used = state.poolStats.usedMemMb}
            {@const total = state.poolStats.totalMemMb}
            {@const pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0}
            <div class="resource-panel">
              <div class="resource-label">
                <span>System RAM</span>
                <span class="resource-nums">{used.toLocaleString()} / {total.toLocaleString()} MB ({pct}%)</span>
              </div>
              <div class="ram-bar-track">
                <div class="ram-bar-fill" class:ram-warn={pct >= 80} style="width: {pct}%"></div>
              </div>
              <p class="resource-note">Includes all processes. GPU models consume VRAM (not shown).</p>
            </div>
          {/if}

          <!-- Pool table -->
          <div class="monitor-section">
            <h3>Model Pool</h3>
            {#if state.pool.length === 0}
              <p class="monitor-empty">No models loaded.</p>
            {:else}
              <table class="pool-table-full">
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Variant</th>
                    <th>Status</th>
                    <th>Device</th>
                    <th title="Tokens in this session">↑ In</th>
                    <th title="Tokens out this session">↓ Out</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {#each state.pool as entry (entry.alias)}
                    {@const shortVariant = entry.variantId?.split(':')[0]?.split('-').slice(-3).join('-') ?? '—'}
                    {@const poolBadge = accelBadgeInfo(
                      entry.variantId?.toLowerCase().includes('gpu') ? 'GPU' : entry.variantId?.toLowerCase().includes('npu') ? 'NPU' : 'CPU',
                      entry.variantId?.toLowerCase().includes('cuda') ? 'CUDA' : entry.variantId?.toLowerCase().includes('qnn') ? 'QNN' : entry.variantId?.toLowerCase().includes('dml') ? 'DML' : 'generic'
                    )}
                    {@const tokens = state.poolStats?.tokenTotals?.find((t: any) => t.alias === entry.alias)}
                    <tr>
                      <td class="pool-alias-cell">{entry.alias}</td>
                      <td class="pool-variant-cell" title={entry.variantId}>{shortVariant}</td>
                      <td>
                        <span class="badge" class:loaded={entry.isLoaded === true} class:warn={entry.isLoaded === false}>
                          {entry.isLoaded === true ? 'Loaded' : entry.isLoaded === false ? 'Evicted' : 'Active'}
                        </span>
                      </td>
                      <td>
                        <span class="accel-badge {poolBadge.cls}">{poolBadge.label}</span>
                      </td>
                      <td class="pool-tokens-cell">{tokens?.tokensIn ?? '—'}</td>
                      <td class="pool-tokens-cell">{tokens?.tokensOut ?? '—'}</td>
                      <td><button class="small danger-btn" onclick={() => sdkUnloadModel({ alias: entry.alias }).then(refreshMonitorNow)}>Unload</button></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>

          <!-- Access log -->
          <div class="monitor-section">
            <div class="log-toolbar">
              <h3>Access Log <span class="log-count">({monitorLog.length} entries)</span></h3>
              <label class="pause-label">
                <input type="checkbox" bind:checked={monitorLogPaused} />
                Pause
              </label>
              <button class="small" onclick={() => { monitorLog = []; }}>Clear display</button>
              <button class="small" onclick={() => exportAccessLog('json')}>Export JSON</button>
              <button class="small" onclick={() => exportAccessLog('csv')}>Export CSV</button>
            </div>
            <p class="log-note">In-memory: last 500 requests · Disk: <code>~/.flint/logs/</code> retained 7 days</p>
            {#if monitorLog.length === 0}
              <p class="monitor-empty">No log entries yet. Send a message or transcribe audio to populate.</p>
            {:else}
              <div class="access-log-wrap" role="region" aria-label="Access log" onmouseenter={() => { monitorLogPaused = true; }} onmouseleave={() => { monitorLogPaused = false; }}>
                <table class="access-log-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>Model</th>
                      <th>Duration</th>
                      <th>↑ In</th>
                      <th>↓ Out</th>
                      <th>OK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each monitorLog as entry, i (i)}
                      <tr class:log-row-err={!entry.ok}>
                        <td class="log-time">{new Date(entry.ts).toLocaleTimeString()}</td>
                        <td><span class="log-type-badge log-type-{entry.type}">{entry.type}</span></td>
                        <td class="log-model">{entry.modelAlias ?? '—'}</td>
                        <td class="log-dur">{entry.durationMs != null ? `${entry.durationMs}ms` : '—'}</td>
                        <td class="log-tok">{entry.tokensIn ?? '—'}</td>
                        <td class="log-tok">{entry.tokensOut ?? '—'}</td>
                        <td class="log-ok">{entry.ok ? '✓' : '✗'}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        </div>
      {:else if currentView === "integrations"}
        <div class="view integrations-view">
          <h2>Integrations</h2>
          <p class="integrations-lede">
            Point AI coding tools at your local Flint endpoint. Pick your OS, copy the snippet, drop it into the tool's config.
          </p>

          {#if !state.endpoint}
            <div class="notice">
              <p><strong>The local endpoint is not running.</strong></p>
              <p>Start the service in <button class="link-like" onclick={() => (currentView = "diagnostics")}>Diagnostics</button> to populate live URLs in the snippets below.</p>
            </div>
          {/if}

          <div class="integrations-toolbar">
            <span class="os-toggle-label">OS:</span>
            <button
              class="os-toggle"
              class:active={integrationsOS === 'windows'}
              onclick={() => (integrationsOS = 'windows')}
              type="button"
            >Windows</button>
            <button
              class="os-toggle"
              class:active={integrationsOS === 'unix'}
              onclick={() => (integrationsOS = 'unix')}
              type="button"
            >macOS / Linux</button>
            <span class="endpoint-hint">
              Endpoint:
              <code>{state.endpoint || 'not started'}</code>
            </span>
          </div>

          <div class="integration-cards">
            {#each integrations as integration (integration.id)}
              {@const osSnippets = integration.snippets[integrationsOS]}
              {@const isExpanded = expandedIntegrationId === integration.id}
              <article class="integration-card" class:status-unsupported={integration.status === 'unsupported'}>
                <header class="integration-card-head">
                  <div class="integration-title">
                    <h3>{integration.name}</h3>
                    <span class="integration-vendor">{integration.vendor}</span>
                  </div>
                  <span class="status-badge status-{integration.status}">
                    {statusBadgeLabel(integration.status)}
                  </span>
                </header>
                <p class="integration-desc">{integration.description}</p>

                {#if osSnippets.length === 0}
                  <p class="integration-empty">No snippet — see limitations below.</p>
                {:else}
                  {#each osSnippets as snippet, snippetIdx}
                    {@const snippetKey = `${integration.id}-${integrationsOS}-${snippetIdx}`}
                    {@const rendered = renderSnippet(snippet.body, state.endpoint || '')}
                    <div class="snippet-block">
                      <div class="snippet-head">
                        <span class="snippet-label">{snippet.label}</span>
                        <button
                          class="snippet-copy"
                          type="button"
                          onclick={() => copyIntegrationSnippet(snippetKey, rendered)}
                        >
                          {copiedSnippetKey === snippetKey ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <pre class="snippet-body">{rendered}</pre>
                    </div>
                  {/each}
                {/if}

                {#if (integration.limitations && integration.limitations.length) || integration.docsUrl}
                  <button
                    class="integration-toggle"
                    type="button"
                    onclick={() => (expandedIntegrationId = isExpanded ? null : integration.id)}
                  >
                    {isExpanded ? 'Hide details' : 'Show limitations & docs'}
                  </button>
                  {#if isExpanded}
                    <div class="integration-details">
                      {#if integration.limitations?.length}
                        <ul class="integration-limitations">
                          {#each integration.limitations as note}
                            <li>{note}</li>
                          {/each}
                        </ul>
                      {/if}
                      {#if integration.docsUrl}
                        <a class="integration-docs-link" href={integration.docsUrl} target="_blank" rel="noopener noreferrer">Upstream docs ↗</a>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </article>
            {/each}
          </div>
        </div>
      {:else if currentView === "learn"}
        <div class="view">
          <h2>Learn about Foundry Local</h2>
          <p>
            Flint bundles the Foundry Local runtime (~20MB) for a seamless
            experience. No separate CLI or runtime install required.
          </p>
          <p>
            On first launch we detect your hardware accelerators and suggest 1-3
            small starter models.
          </p>
          <ul>
            <li>Models run entirely on your device</li>
            <li>Uses the same OpenAI-compatible interface as Azure</li>
            <li>Automatic hardware acceleration (CPU / GPU / NPU)</li>
          </ul>

          <h3>Using the Local Endpoint</h3>
          {#if state.endpoint}
            <div class="endpoint-snippet">
              <strong>Endpoint:</strong> <code>{state.endpoint}</code>
              <button
                onclick={() =>
                  navigator.clipboard.writeText(state.endpoint || "")}
                >Copy</button
              >
            </div>
            <p>
              Full setup snippets for AI coding tools (Continue.dev, OpenCode,
              Codex CLI, generic OpenAI SDKs, and more) live in the
              <button class="link-like" onclick={() => (currentView = "integrations")}
                >Integrations</button
              > tab — with per-OS commands and copy buttons.
            </p>
          {:else}
            <p>
              Start the service in Diagnostics, then open the
              <button class="link-like" onclick={() => (currentView = "integrations")}
                >Integrations</button
              > tab for copy-paste setup snippets.
            </p>
          {/if}

          <h3>Tool Calling</h3>
          <p>
            Foundry Local exposes an OpenAI-compatible API, and many models on
            this endpoint support tool calling (also called function calling) —
            the model can emit a <code>tool_calls</code> object in its response
            that describes what function to invoke. A <em>client application</em>
            is then responsible for executing that call and returning the result.
          </p>
          <p><strong>What Foundry Local provides:</strong></p>
          <ul>
            <li>The model runtime and the OpenAI-compatible inference endpoint</li>
            <li>Tool-call JSON in responses (<code>tool_calls</code> / <code>function_call</code>) when a model supports it</li>
            <li>The surface that AI coding tools — Continue.dev, Cline, Claude Code, GitHub Copilot — connect to</li>
          </ul>
          <p><strong>What Flint does (and does not do):</strong></p>
          <ul>
            <li>Flint manages model loading, service configuration, and endpoint setup</li>
            <li>Flint's chat window displays model responses — it does <strong>not</strong> parse, execute, or forward tool calls on your behalf</li>
            <li>No shell commands, file operations, or network requests are run automatically based on model output</li>
            <li>Tool execution belongs to the AI client you connect to the endpoint (Cline, Continue, your own code, etc.)</li>
          </ul>
          <p>
            To use tool-capable models in a full agentic workflow, point one of
            the clients above at the local endpoint shown in this tab. Flint's
            role is to keep the model running — the calling client controls
            which tools are allowed, when they run, and what confirmation the
            user sees.
          </p>

          <p>
            <a href="https://github.com/microsoft/Foundry-Local" target="_blank"
              >Official Foundry Local repo →</a
            >
          </p>
        </div>
      {:else if currentView === "compare"}
        <div class="view compare-view">
          <h2>Model Comparison</h2>
          <p class="muted">Send the same prompt to 2–3 models and compare side-by-side (non-streaming for 0.3).</p>

          <div class="compare-controls">
            <div>
              <label>Select models (max 3, prefer loaded):</label>
              <div class="model-pills">
                {#each state.models.filter(m => m.isCached) as m (m.alias)}
                  <div class="pill-wrapper">
                    <button
                      class="pill"
                      class:selected={compareSelected.includes(m.alias)}
                      onclick={() => {
                        if (compareSelected.includes(m.alias)) {
                          compareSelected = compareSelected.filter(a => a !== m.alias);
                        } else if (compareSelected.length < 3) {
                          compareSelected = [...compareSelected, m.alias];
                        }
                      }}
                    >
                      {m.alias} {m.isLoaded ? '●' : ''}
                    </button>
                    {#if !m.isLoaded}
                      <button class="tiny" onclick={() => loadModelForCompare(m.alias)} title="Load this model">Load</button>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>

            <textarea bind:value={comparePrompt} placeholder="Enter the same prompt for all selected models..." rows={3}></textarea>

            <div class="actions">
              <button onclick={runComparison} disabled={compareSelected.length < 2 || !comparePrompt.trim() || isComparing}>
                {isComparing ? 'Comparing...' : 'Run Comparison'}
              </button>
              {#if Object.keys(compareResults).length}
                <button class="secondary" onclick={exportComparison}>Export Markdown</button>
                <button class="secondary" onclick={() => { compareResults = {}; }}>Clear Results</button>
              {/if}
            </div>
          </div>

          {#if Object.keys(compareResults).length}
            <div class="compare-results" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 16px;">
              {#each compareSelected as alias (alias)}
                {@const r = compareResults[alias] || {}}
                <div class="compare-card">
                  <div class="card-header">
                    <strong>{alias}</strong>
                    {#if r.latencyMs}<span class="badge">{r.latencyMs}ms</span>{/if}
                    {#if r.tokensOut}<span class="badge">{r.tokensOut} tokens</span>{/if}
                  </div>
                  <div class="result-body">
                    {#if r.content}
                      <div class="result-content">
                        <MessageRenderer content={r.content || ''} />
                      </div>
                    {:else}
                      <em>No result yet.</em>
                    {/if}
                  </div>
                  <div class="rating">
                    <button class:selected={r.rating==='up'} onclick={() => setCompareRating(alias, 'up')}>👍</button>
                    <button class:selected={r.rating==='down'} onclick={() => setCompareRating(alias, 'down')}>👎</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>

      {:else if currentView === "settings"}
        <div class="view settings-view">
          <h2>Settings</h2>

          <div class="settings-section">
            <h3>System</h3>
            {#if !isDev}
              <div class="setting-row">
                <div class="setting-info">
                  <span class="setting-name">Launch Flint when the OS starts</span>
                  <span class="setting-desc">Registers Flint as a login item (Windows) or LaunchAgent (macOS).</span>
                </div>
                {#if osAutoStartEnabled === null}
                  <span class="setting-loading">…</span>
                {:else}
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      checked={osAutoStartEnabled === true}
                      onchange={handleOsAutoStartToggle}
                    />
                    <span class="toggle-track"></span>
                  </label>
                {/if}
              </div>
            {/if}
          </div>

          <div class="settings-section">
            <h3>Startup</h3>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">Start local service automatically</span>
                <span class="setting-desc">Load the default model and start the inference service when Flint opens</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" bind:checked={autoStartService} onchange={persistChat} />
                <span class="toggle-track"></span>
              </label>
            </div>

            {#if autoStartService}
              <div class="setting-row setting-row-indent">
                <label class="setting-info" for="default-chat-model">
                  <span class="setting-name">Default chat model</span>
                  <span class="setting-desc">Model to load on startup — "Last used" restores your previous session</span>
                </label>
                <select id="default-chat-model" bind:value={defaultChatAlias} onchange={persistChat}>
                  <option value="">Last used</option>
                  {#each state.models.filter((m: ModelInfo) => m.isCached) as m (m.alias)}
                    <option value={m.alias}>{m.alias}</option>
                  {/each}
                </select>
              </div>
              <div class="setting-row setting-row-indent">
                <label class="setting-info" for="default-audio-model">
                  <span class="setting-name">Default audio model</span>
                  <span class="setting-desc">STT model to pre-select on startup</span>
                </label>
                <select id="default-audio-model" bind:value={defaultAudioAlias} onchange={persistChat}>
                  <option value="">Last used</option>
                  {#each sttModels.filter((m: any) => m.isCached) as m (m.alias)}
                    <option value={m.alias}>{m.alias}</option>
                  {/each}
                </select>
              </div>
            {/if}
          </div>

          <div class="settings-section">
            <h3>Network</h3>
            <p class="setting-note">Changes take effect after the next service restart.</p>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">Port</span>
                <span class="setting-desc">Port the local inference service listens on (default: 5272)</span>
              </div>
              <input
                type="number"
                class="port-input"
                min="1024"
                max="65535"
                bind:value={networkPort}
                onchange={persistChat}
              />
            </div>

            <div class="setting-col">
              <div class="setting-info">
                <span class="setting-name">Bind address</span>
                <span class="setting-desc">Network interface the service listens on</span>
              </div>
              <label class="radio-option">
                <input type="radio" name="bind-addr" checked={networkBindAddress === '127.0.0.1'}
                  onchange={() => { networkBindAddress = '127.0.0.1'; persistChat(); }} />
                <span>127.0.0.1 — loopback only <span class="badge-recommend">Recommended</span></span>
              </label>
              <label class="radio-option">
                <input type="radio" name="bind-addr" checked={networkBindAddress === '0.0.0.0'}
                  onchange={() => { networkBindAddress = '0.0.0.0'; persistChat(); }} />
                <span>0.0.0.0 — all interfaces</span>
              </label>
              <label class="radio-option">
                <input type="radio" name="bind-addr" checked={networkBindAddress !== '127.0.0.1' && networkBindAddress !== '0.0.0.0'}
                  onchange={() => { if (networkBindAddress === '127.0.0.1' || networkBindAddress === '0.0.0.0') { networkBindAddress = ''; } }} />
                <span>Custom</span>
              </label>
              {#if networkBindAddress !== '127.0.0.1' && networkBindAddress !== '0.0.0.0'}
                <input type="text" class="custom-bind-input" bind:value={networkBindAddress} onchange={persistChat} placeholder="e.g. 192.168.1.100" />
              {/if}
              {#if networkBindAddress !== '127.0.0.1'}
                <div class="warning-banner">
                  Binding to {networkBindAddress || 'all interfaces'} exposes the local inference service to other machines on the same network. Ensure your OS firewall is configured appropriately.
                </div>
              {/if}
            </div>
          </div>

          <div class="settings-section">
            <h3>Appearance</h3>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-name">Theme</span>
              </div>
              <div class="theme-toggle-group">
                <button
                  class="theme-option"
                  class:active={theme === 'light'}
                  onclick={() => { theme = 'light'; }}
                  aria-pressed={theme === 'light'}
                >Light</button>
                <button
                  class="theme-option"
                  class:active={theme === 'dark'}
                  onclick={() => { theme = 'dark'; }}
                  aria-pressed={theme === 'dark'}
                >Dark</button>
              </div>
            </div>
          </div>
        </div>
      {/if}
    </section>
  </div>

  {#if showShortcutsHelp}
    <div class="shortcuts-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <button class="shortcuts-backdrop" onclick={() => { showShortcutsHelp = false; }} aria-label="Close keyboard shortcuts dialog"></button>
      <div class="shortcuts-dialog">
        <div class="shortcuts-header">
          <h3>Keyboard Shortcuts</h3>
          <button onclick={() => { showShortcutsHelp = false; }} aria-label="Close">×</button>
        </div>
        <table class="shortcuts-table">
          <tbody>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+Enter</td><td>Send message</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+Shift+N</td><td>New conversation</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+1</td><td>Chat</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+2</td><td>Models</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+3</td><td>Audio</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+4</td><td>Monitor</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+5</td><td>Integrations</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+,</td><td>Settings</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+B</td><td>Toggle sidebar</td></tr>
            <tr><td class="sk">{isMac ? '⌘' : 'Ctrl'}+Space</td><td>Toggle dictation</td></tr>
            <tr><td class="sk">?</td><td>Show this help</td></tr>
            <tr><td class="sk">Escape</td><td>Close this dialog</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</main>

<style>
  /* Inline SVG icons sit on the text baseline */
  :global(svg[aria-hidden="true"]) {
    display: inline-block;
    vertical-align: -0.175em;
    flex-shrink: 0;
  }

  :root {
    font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.5;

    /* Theme variables - dark defaults */
    --bg: #1a1a1e;
    --fg: #e8e8e8;
    --header-bg: #111114;
    --sidebar-bg: #111114;
    --panel-bg: #222226;
    --border: #2a2a30;
    --accent: #3b82f6;
    --muted: #888;
    --success: #4ade80;
    --warning: #facc15;
    --danger: #f87171;
    --input-bg: #222226;
    --button-bg: #001639;
    --subtle-bg: #2a2a30;
    --messages-bg: #16161a;
  }

  :global([data-theme="light"]) {
    --bg: #f8f9fa;
    --fg: #212529;
    --header-bg: #ffffff;
    --sidebar-bg: #f1f3f5;
    --panel-bg: #ffffff;
    --border: #dee2e6;
    --accent: #0d6efd;
    --muted: #6c757d;
    --success: #198754;
    --warning: #ffc107;
    --danger: #dc3545;
    --input-bg: #ffffff;
    --button-bg: #001639;
    --subtle-bg: #e9ecef;
    --messages-bg: #f8f9fa;
  }

  /* Ensure body and html follow the theme background and have no default margins */
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background-color: var(--bg);
    color: var(--fg);
  }

  :global(html) {
    height: 100%;
  }

  :global(body) {
    height: 100%;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border);
  }

  .brand {
    font-size: 1.25rem;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .brand-logo {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: block;
    object-fit: contain;
  }

  .status-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 0.875rem;
  }

  .status {
    color: var(--muted);
  }

  .status.ready {
    color: var(--success);
  }

  .status.error {
    color: var(--danger);
  }

  .endpoint {
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    background: var(--subtle-bg);
    padding: 2px 6px;
    border-radius: 3px;
  }

  .accel {
    font-size: 0.75rem;
    background: color-mix(in srgb, var(--success) 20%, var(--panel-bg));
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--success);
  }

  .current-model {
    font-size: 0.75rem;
    background: color-mix(in srgb, var(--warning) 20%, var(--panel-bg));
    padding: 1px 6px;
    border-radius: 3px;
    color: var(--fg);
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .service-badge {
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--panel-bg);
  }
  .service-badge.running {
    background: color-mix(in srgb, var(--success) 30%, var(--panel-bg));
    color: var(--success);
  }

  button.tiny {
    font-size: 0.7rem;
    padding: 1px 6px;
    background: var(--panel-bg);
    border: 1px solid var(--border);
  }

  .theme-toggle {
    font-size: 1rem;
    background: none;
    border: 1px solid var(--border);
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
  }

  .status-msg {
    color: var(--muted);
    font-size: 0.8rem;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .sidebar {
    width: 200px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    padding: 12px 0;
    display: flex;
    flex-direction: column;
  }

  .nav-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 10px 20px;
    background: none;
    border: none;
    color: var(--fg);
    font-size: 0.95rem;
    cursor: pointer;
    position: relative;
  }

  .nav-item:hover {
    background: color-mix(in srgb, var(--sidebar-bg) 70%, var(--panel-bg));
  }

  .nav-item.active {
    background: var(--panel-bg);
    color: var(--fg);
  }

  .nav-item.active::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    background: var(--accent);
    border-radius: 2px;
  }

  .sidebar-footer {
    margin-top: auto;
    padding: 16px 20px;
    font-size: 0.75rem;
    color: var(--muted);
  }

  .sidebar.collapsed {
    width: 52px;
  }

  .sidebar.collapsed .nav-item {
    padding: 10px 8px;
    text-align: center;
    font-size: 1.1rem;
  }

  .sidebar.collapsed .nav-item.active::before {
    left: 3px;
    top: 4px;
    bottom: 4px;
  }

  .collapse-toggle {
    font-size: 0.9rem;
    padding: 6px 20px !important;
    margin-bottom: 8px;
    opacity: 0.7;
    display: flex;
    justify-content: flex-start;
    align-items: center;
  }

  .collapse-icon {
    width: 18px;
    height: 18px;
    display: block;
    transition: transform 0.2s ease;
  }

  .collapse-icon.collapsed {
    transform: scaleX(-1);
  }

  .sidebar.collapsed .collapse-toggle {
    padding: 6px 8px !important;
    justify-content: center;
  }

  .nav-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-right: 8px;
    width: 1.2em;
  }

  .nav-icon-svg {
    width: 1.05em;
    height: 1.05em;
    stroke: currentColor;
    fill: none;
    flex: 0 0 auto;
  }

  .nav-label {
    display: inline;
  }

  .sidebar.collapsed .nav-label {
    display: none;
  }

  .sidebar.collapsed .nav-icon {
    margin-right: 0;
  }

  .content {
    flex: 1;
    padding: 24px;
    overflow: auto;
    background: var(--bg);
  }

  h2 {
    margin-top: 0;
    margin-bottom: 16px;
  }

  .toolbar {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }

  .accel-panel {
    margin: 0 0 14px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--subtle-bg);
  }

  .accel-panel-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .accel-panel-row label {
    font-size: 0.85rem;
    color: var(--muted);
  }

  .accel-panel-row select {
    min-width: 260px;
    padding: 6px 8px;
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .ep-status-list {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .ep-pill {
    font-size: 0.75rem;
    padding: 2px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--danger) 18%, var(--panel-bg));
    color: var(--fg);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
  }

  .ep-pill.ready {
    background: color-mix(in srgb, #16a34a 20%, var(--panel-bg));
    border-color: color-mix(in srgb, #16a34a 40%, var(--border));
  }

  input {
    flex: 1;
    padding: 8px 12px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 6px;
  }

  .model-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }

  .model-card {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
  }

  .model-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .badges {
    display: flex;
    gap: 4px;
  }

  .badge {
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--subtle-bg);
    color: var(--fg);
  }

  .badge.cached {
    background: #166534;
    color: #86efac;
  }
  .badge.loaded {
    background: #1e40af;
    color: #93c5fd;
  }

  .badge.warn {
    background: #7c2d12;
    color: #fed7aa;
  }

  .badge.small {
    font-size: 0.68rem;
    padding: 1px 5px;
  }

  .model-meta {
    display: grid;
    gap: 4px;
    font-size: 0.8rem;
    color: var(--muted);
    margin-bottom: 12px;
  }

  .meta-badges {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: 4px;
    vertical-align: middle;
  }

  .meta-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--subtle-bg);
    color: var(--fg);
    font-size: 0.72rem;
    line-height: 1.2;
  }

  .model-short-desc {
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .model-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  /* Pool panel */
  .pool-panel {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  .pool-panel-header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 10px;
  }

  .pool-panel-header h3 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .pool-mem {
    font-size: 0.78rem;
    color: var(--muted);
  }

  .pool-table {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pool-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.82rem;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
  }

  .pool-row:last-child {
    border-bottom: none;
  }

  .pool-alias {
    font-weight: 500;
    min-width: 120px;
  }

  .pool-variant {
    color: var(--muted);
    font-family: monospace;
    font-size: 0.75rem;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pool-tokens {
    font-size: 0.75rem;
    color: var(--muted);
    white-space: nowrap;
  }

  /* Variant section */
  .variant-section {
    margin: 8px 0;
    padding: 0;
  }

  .variant-toggle {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 3px 8px;
  }

  .variant-toggle:hover {
    color: var(--fg);
    border-color: var(--accent);
  }

  .variant-list {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 2px solid var(--border);
    padding-left: 10px;
  }

  .variant-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    padding: 3px 0;
  }

  .variant-row.variant-active {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-radius: 4px;
    padding: 3px 6px;
  }

  .accel-badge {
    display: inline-block;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    white-space: nowrap;
    letter-spacing: 0.01em;
    border: 1px solid transparent;
    /* default (Generic/CPU) */
    background: #1e293b;
    color: #94a3b8;
    border-color: #334155;
  }
  /* NVIDIA: CUDA / TensorRT */
  .ep-cuda, .ep-tensorrt {
    background: #0e2a12;
    color: #76b900;
    border-color: #2a5a0a;
  }
  /* AMD: Vitis */
  .ep-vitis {
    background: #2a0a0a;
    color: #ff3e00;
    border-color: #5a1010;
  }
  /* Intel: OpenVINO */
  .ep-openvino {
    background: #0a1a2e;
    color: #54aaff;
    border-color: #0057ae;
  }
  /* Qualcomm: QNN */
  .ep-qnn {
    background: #0a1a2a;
    color: #3399ff;
    border-color: #0048a8;
  }
  /* Microsoft: DirectML */
  .ep-dml {
    background: #0a1428;
    color: #50b0f0;
    border-color: #005eb8;
  }
  /* WebGPU */
  .ep-webgpu {
    background: #1a0e2a;
    color: #c084fc;
    border-color: #6b21a8;
  }

  .variant-size {
    font-size: 0.75rem;
    color: var(--muted);
  }

  button.small {
    font-size: 0.75rem;
    padding: 2px 8px;
  }

  /* Startup toggle */
  .startup-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.78rem;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }

  .startup-toggle input[type="checkbox"] {
    cursor: pointer;
  }

  .startup-variant-hint {
    font-size: 0.72rem;
    opacity: 0.65;
    font-family: monospace;
  }

  .danger-btn {
    border-color: #ef4444;
    color: #fecaca;
  }

  .model-details {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
    display: grid;
    gap: 6px;
    font-size: 0.78rem;
    color: var(--muted);
  }

  .model-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 210;
  }

  .model-modal {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    width: min(700px, 94vw);
    max-height: 85vh;
    overflow: auto;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
  }

  .model-detail-grid {
    display: grid;
    gap: 8px;
    font-size: 0.85rem;
    color: var(--muted);
  }

  button {
    padding: 6px 12px;
    background: var(--button-bg);
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.secondary {
    background: var(--subtle-bg);
    color: var(--fg);
  }

  .notice {
    background: color-mix(in srgb, var(--danger) 10%, var(--panel-bg));
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--border));
    padding: 16px;
    border-radius: 8px;
    max-width: 520px;
  }

  .placeholder {
    color: var(--muted);
    font-style: italic;
  }

  .privacy {
    margin-top: 8px;
  }

  .recommendations {
    margin: 16px 0;
    padding: 12px;
    background: var(--subtle-bg);
    border-radius: 8px;
  }

  .recommendations h3 {
    margin: 0 0 8px;
    font-size: 1rem;
  }

  .starter-options {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .starter-card {
    background: var(--panel-bg);
    padding: 8px 12px;
    border-radius: 6px;
    min-width: 160px;
  }

  .starter-card .actions {
    margin-top: 6px;
  }

  .hardware-info {
    font-size: 0.8rem;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .size {
    font-size: 0.7rem;
    color: var(--muted);
    margin-left: 6px;
  }

  .current-badge {
    font-size: 0.65rem;
    background: #4ade80;
    color: #111;
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: bold;
    align-self: center;
  }

  .primary-chat {
    background: #22c55e !important;
  }

  /* Chat styles */
  .chat-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .chat-container {
    display: flex;
    flex: 1;
    gap: 0;
    min-height: 0;
  }

  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .chat-header h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    background: var(--messages-bg);
    padding: 12px 16px;
    margin: 12px 12px 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
  }

  .empty-chat {
    color: var(--muted);
    text-align: center;
    padding: 40px 20px;
  }

  .message {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    align-items: flex-start;
  }

  .message.user {
    justify-content: flex-end;
  }

  .message .role {
    font-size: 1.2rem;
    flex-shrink: 0;
    min-width: 24px;
    text-align: center;
  }

  .message .content {
    max-width: 70%;
    background: var(--panel-bg);
    padding: 10px 12px;
    border-radius: 8px;
    color: var(--fg);
  }

  .message.user .content {
    background: color-mix(in srgb, var(--accent) 25%, var(--panel-bg));
  }

  .message.summary {
    opacity: 0.92;
  }
  .message.summary .content {
    border-left: 3px solid var(--muted);
    background: var(--subtle-bg);
  }
  .summary-label {
    font-size: 0.65rem;
    color: var(--muted);
    font-weight: 600;
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .message.pinned {
    border-left: 3px solid var(--warning);
  }

  .pin-btn {
    font-size: 0.7rem;
    background: none;
    border: none;
    padding: 0 2px;
    margin-left: 2px;
    cursor: pointer;
    opacity: 0.5;
    color: var(--muted);
    line-height: 1;
  }
  .pin-btn:hover {
    opacity: 1;
  }
  .pin-btn.pinned {
    color: var(--warning);
    opacity: 1;
  }

  .condensed-hint {
    font-size: 0.65rem;
    font-style: italic;
    color: var(--muted);
    margin-bottom: 4px;
  }

  .message.condensed {
    opacity: 0.65;
  }

  .chat-controls {
    padding: 0 12px;
    margin-bottom: 8px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    position: relative;
    z-index: 20;
    overflow: visible;
  }

  .persona-control {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    position: relative;
    z-index: 30;
  }

  .vision-attach {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }

  .vision-attach button {
    padding: 4px 8px;
    font-size: 0.75rem;
  }

  .image-strip {
    display: flex;
    gap: 4px;
  }
  .thumb {
    position: relative;
    width: 44px;
    height: 44px;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  .thumb .mini {
    position: absolute;
    top: -4px;
    right: -4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 50%;
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    padding: 0;
  }

  .attached {
    color: var(--success); 

  .compare-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    background: var(--panel-bg, #111);
  }
  .compare-card .card-header {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }
  .compare-card .badge {
    font-size: 0.7em;
    background: var(--accent, #333);
    padding: 1px 6px;
    border-radius: 3px;
  }
  .compare-card .rating button {
    margin-right: 4px;
    opacity: 0.7;
  }
  .compare-card .rating button.selected {
    opacity: 1;
    font-weight: bold;
  }
    font-size: 0.8rem;
  }

  .mini {
    padding: 0 2px !important;
    background: none !important;
    color: var(--muted) !important;
    font-size: 0.9rem;
  }

  .mini:hover {
    color: var(--danger) !important;
  }

  .chat-input {
    display: flex;
    gap: 8px;
    padding: 12px;
    background: var(--panel-bg);
    border-top: 1px solid var(--border);
    border-radius: 0;
    position: relative;
    z-index: 1;
  }

  .chat-input input {
    flex: 1;
    padding: 10px 12px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 6px;
    font-size: 0.95rem;
  }

  .chat-input button {
    padding: 8px 16px;
    background: var(--button-bg);
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    min-width: 60px;
  }

  .chat-input button:hover {
    background: color-mix(in srgb, var(--accent) 80%, #000);
  }

  .chat-input button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .chat-input .stop {
    background: var(--danger) !important;
  }

  .chat-input .stop:hover {
    background: color-mix(in srgb, var(--danger) 70%, #000) !important;
  }

  .chat-input .dictation-btn {
    min-width: 36px;
    padding: 8px 10px;
    background: var(--panel-bg);
    border: 1px solid var(--border);
    color: var(--fg);
    font-size: 1rem;
  }

  .chat-input .dictation-btn.active {
    background: color-mix(in srgb, var(--danger) 30%, var(--panel-bg));
    border-color: var(--danger);
  }

  .chat-input .dictation-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 20%, var(--panel-bg));
  }

  .dictation-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: color-mix(in srgb, var(--accent) 10%, var(--panel-bg));
    border-top: 1px solid var(--border);
    font-size: 0.85rem;
    color: var(--fg);
    min-height: 32px;
  }

  .dictation-indicator {
    flex-shrink: 0;
  }

  .dictation-indicator.pulsing {
    animation: dictation-pulse 1.2s ease-in-out infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* Spin the loader icon in the send button while streaming */
  /* :global needed because Icon component renders the SVG in its own scope */
  .chat-input button[type="submit"] :global(svg) {
    display: inline-block;
    vertical-align: -0.175em;
  }

  .chat-input button[type="submit"] :global(svg.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes dictation-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .dictation-interim {
    font-style: italic;
    color: var(--fg);
    opacity: 0.8;
  }

  .dictation-hint {
    color: var(--muted);
    font-style: italic;
  }

  .streaming {
    animation: pulse-animation 1.5s infinite;
  }

  @keyframes pulse-animation {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }

  .typing-indicator {
    display: inline-flex;
    gap: 3px;
  }

  .typing-indicator::after {
    content: "●●●";
    animation: typing 1.4s infinite;
    letter-spacing: 2px;
  }

  @keyframes typing {
    0%,
    60%,
    100% {
      opacity: 0.3;
    }
    30% {
      opacity: 1;
    }
  }

  .stop {
    background: var(--danger) !important;
  }

  .audio-view .audio-controls {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .audio-language {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.78rem;
    color: var(--muted);
  }

  .audio-language select {
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 6px;
    padding: 6px 8px;
    min-width: 120px;
  }

  .audio-info {
    margin: 8px 0;
    color: var(--muted);
  }

  .transcription-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }

  .stt-models {
    margin: 12px 0;
  }
  .stt-btn {
    font-size: 0.8rem;
    padding: 4px 8px;
    margin: 2px;
    background: var(--subtle-bg);
    color: var(--fg);
  }

  .stt-picker {
    margin: 8px 0 12px;
    font-size: 0.85rem;
  }
  .current-stt {
    font-family: ui-monospace, monospace;
    background: var(--subtle-bg);
    padding: 1px 6px;
    border-radius: 3px;
    margin: 0 6px;
  }

  .vision-attach {
    margin-bottom: 8px;
    font-size: 0.8rem;
  }

  .service-panel {
    background: var(--panel-bg);
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 16px;
  }

  .status-row {
    display: flex;
    gap: 8px;
    margin: 8px 0;
  }

  .status.running {
    color: var(--success);
    font-weight: bold;
  }
  .status.stopped {
    color: var(--danger);
  }

  .endpoint-display {
    font-family: monospace;
    background: var(--subtle-bg);
    padding: 8px;
    border-radius: 4px;
    margin: 8px 0;
  }

  .service-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .endpoint-snippet {
    margin: 12px 0;
    padding: 8px;
    background: var(--panel-bg);
    border-radius: 6px;
  }

  .endpoint-snippet code {
    word-break: break-all;
  }

  /* Integrations view */
  .integrations-view .integrations-lede {
    color: var(--muted);
    margin-bottom: 14px;
  }

  .integrations-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 18px 0;
    flex-wrap: wrap;
  }

  .os-toggle-label {
    color: var(--muted);
    font-size: 13px;
  }

  .os-toggle {
    padding: 4px 12px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }

  .os-toggle:hover {
    border-color: var(--accent);
    color: var(--fg);
  }

  .os-toggle.active {
    background: var(--accent);
    color: var(--accent-fg, #fff);
    border-color: var(--accent);
  }

  .endpoint-hint {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
  }

  .endpoint-hint code {
    color: var(--fg);
    word-break: break-all;
  }

  .integration-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 12px;
  }

  .integration-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    background: var(--panel-bg);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .integration-card.status-unsupported {
    opacity: 0.85;
  }

  .integration-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .integration-title h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .integration-vendor {
    color: var(--muted);
    font-size: 12px;
  }

  .status-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .status-badge.status-verified {
    background: rgba(40, 180, 99, 0.12);
    color: #28b463;
    border-color: rgba(40, 180, 99, 0.4);
  }

  .status-badge.status-community {
    background: rgba(52, 152, 219, 0.12);
    color: #3498db;
    border-color: rgba(52, 152, 219, 0.4);
  }

  .status-badge.status-research-needed {
    background: rgba(241, 196, 15, 0.12);
    color: #d4a017;
    border-color: rgba(241, 196, 15, 0.4);
  }

  .status-badge.status-unsupported {
    background: rgba(231, 76, 60, 0.1);
    color: #e74c3c;
    border-color: rgba(231, 76, 60, 0.4);
  }

  .integration-desc {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .integration-empty {
    margin: 0;
    color: var(--muted);
    font-style: italic;
    font-size: 13px;
  }

  .snippet-block {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg);
  }

  .snippet-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-bg);
  }

  .snippet-label {
    font-size: 12px;
    color: var(--muted);
    font-weight: 500;
  }

  .snippet-copy {
    padding: 2px 10px;
    font-size: 12px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    border-radius: 4px;
    cursor: pointer;
  }

  .snippet-copy:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .snippet-body {
    margin: 0;
    padding: 10px 12px;
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", monospace;
    font-size: 12px;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre;
    color: var(--fg);
  }

  .integration-toggle {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    font-size: 12px;
    text-decoration: underline;
  }

  .integration-details {
    border-top: 1px solid var(--border);
    padding-top: 8px;
    font-size: 13px;
  }

  .integration-limitations {
    margin: 0 0 8px 0;
    padding-left: 18px;
    color: var(--muted);
    line-height: 1.5;
  }

  .integration-docs-link {
    color: var(--accent);
    font-size: 12px;
  }

  .link-like {
    background: none;
    border: none;
    color: var(--accent);
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    font: inherit;
  }

  .log-viewer {
    margin-top: 16px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .log-viewer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border);
  }

  .log-viewer-header h4 {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .log-count {
    font-weight: 400;
    color: var(--muted);
    font-size: 0.8em;
  }

  .log-actions {
    display: flex;
    gap: 6px;
  }

  .log-list {
    height: 260px;
    overflow-y: auto;
    background: color-mix(in srgb, var(--bg) 60%, var(--panel-bg));
    padding: 4px 0;
    font-family: monospace;
    font-size: 0.75rem;
  }

  .log-entry {
    display: grid;
    grid-template-columns: 54px 46px 40px 1fr;
    gap: 0 6px;
    padding: 2px 10px;
    line-height: 1.5;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }

  .log-entry:last-child { border-bottom: none; }

  .log-ts   { color: var(--muted); white-space: nowrap; }
  .log-src  { color: var(--muted); }
  .log-level { text-transform: uppercase; font-size: 0.7rem; font-weight: 600; opacity: 0.85; }
  .log-msg  { word-break: break-all; }

  .log-info  .log-level { color: var(--accent); }
  .log-debug .log-level { color: var(--muted); }
  .log-warn  .log-level { color: var(--warning); }
  .log-error .log-level { color: var(--danger); }
  .log-error .log-msg   { color: var(--danger); }

  .log-empty {
    padding: 16px;
    color: var(--muted);
    font-size: 0.8rem;
    text-align: center;
  }

  .transcription-result {
    background: var(--panel-bg);
    padding: 12px;
    border-radius: 6px;
    margin-top: 16px;
  }

  .transcription-result pre {
    white-space: pre-wrap;
    font-family: monospace;
    max-height: 200px;
    overflow: auto;
  }

  /* Persona dropdown + manager */
  .persona-btn {
    padding: 2px 8px;
    font-size: 1rem;
    line-height: 1;
    background: var(--subtle-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    color: var(--fg);
  }

  .persona-chip {
    font-size: 0.65rem;
    background: var(--subtle-bg);
    color: var(--muted);
    padding: 1px 5px;
    border-radius: 3px;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-control {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.7rem;
    color: var(--muted);
  }
  .context-control select {
    font-size: 0.7rem;
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 3px;
    padding: 1px 4px;
  }
  .context-estimate {
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    background: color-mix(in srgb, var(--success) 15%, var(--panel-bg));
    color: var(--success);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .context-model-info {
    font-size: 0.6rem;
    color: var(--muted);
    font-family: ui-monospace, monospace;
  }

  .usage-pct {
    font-size: 0.6rem;
    color: var(--success);
    margin-left: 2px;
  }
  .usage-pct.high {
    color: var(--warning);
    font-weight: 600;
  }

  .recommend-btn {
    font-size: 0.6rem;
    padding: 1px 5px;
    background: var(--panel-bg);
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
  }
  .recommend-btn:hover {
    background: var(--accent);
    color: white;
  }

  .context-meter {
    width: 48px;
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
    margin-left: 4px;
  }
  .meter-bar {
    height: 100%;
    width: 100%;
    background: var(--panel-bg);
  }
  .meter-fill {
    height: 100%;
    background: var(--success);
    transition: width 0.2s;
  }
  .meter-fill.warn { background: var(--warning); }
  .meter-fill.danger { background: var(--danger); }

  .context-warn {
    font-size: 0.65rem;
    color: var(--warning);
    margin-left: 4px;
  }

  .compact-btn {
    font-size: 0.65rem;
    padding: 2px 6px;
    background: color-mix(in srgb, var(--warning) 20%, var(--panel-bg));
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  .compact-btn:hover {
    background: color-mix(in srgb, var(--accent) 20%, var(--panel-bg));
  }

  .summarize-btn {
    background: color-mix(in srgb, var(--accent) 20%, var(--panel-bg));
    color: var(--accent);
    border-color: var(--border);
  }
  .summarize-btn:hover {
    background: var(--accent);
    color: white;
  }

  .full-thread-btn {
    background: var(--panel-bg);
    color: var(--fg);
    border-color: var(--border);
  }
  .persona-btn:hover { background: color-mix(in srgb, var(--accent) 15%, var(--panel-bg)); }

  .persona-menu {
    /* Uses position:fixed + inline styles from JS so it can escape .content scroller + chat layers */
    z-index: 9999;
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 260px;
    max-width: 340px;
    max-height: min(420px, 70vh);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    font-size: 0.8rem;
  }

  /* When we decide to open upward (near bottom of window) */
  .persona-menu.up {
    transform: translateY(-100%);
  }

  .persona-menu-items {
    max-height: 260px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .persona-menu-header {
    padding: 6px 10px;
    font-weight: 600;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .persona-menu-header .hint { font-size: 0.7rem; color: var(--muted); }

  .persona-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }
  .persona-item:hover { background: color-mix(in srgb, var(--panel-bg) 80%, var(--bg)); }
  .persona-item.matches {
    background: color-mix(in srgb, var(--accent) 15%, var(--panel-bg));
  }
  .persona-item .p-name { font-weight: 600; display: block; }
  .persona-item .p-desc { font-size: 0.75rem; color: var(--muted); display: block; }
  .persona-item .p-tags { font-size: 0.65rem; color: var(--success); }

  .persona-menu-footer {
    padding: 6px 10px;
    border-top: 1px solid var(--border);
  }
  .manage-link {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.75rem;
    padding: 2px 4px;
    cursor: pointer;
  }

  .local-badge {
    font-size: 0.6rem;
    background: #166534;
    color: #86efac;
    padding: 0 4px;
    border-radius: 2px;
    margin-left: 4px;
    font-weight: 600;
  }

  /* Persona manager modal */
  .persona-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .persona-modal {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    width: min(620px, 92vw);
    max-height: 85vh;
    overflow: auto;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .modal-header h3 { margin: 0; font-size: 1.1rem; }
  .modal-body { padding: 12px 16px; }
  .modal-footer {
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 12px;
    align-items: center;
    font-size: 0.8rem;
  }
  .persona-list-manage {
    max-height: 180px;
    overflow: auto;
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .persona-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    gap: 8px;
  }
  .persona-row:last-child { border-bottom: none; }
  .persona-row-actions { display: flex; gap: 4px; }
  .persona-row-actions button {
    font-size: 0.7rem;
    padding: 2px 6px;
  }
  .persona-row-actions button.danger { color: var(--danger); }
  .add-form input, .add-form textarea {
    width: 100%;
    margin-bottom: 6px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 4px;
    padding: 6px;
    font-size: 0.85rem;
  }
  .form-actions { display: flex; gap: 6px; }
  .small { font-size: 0.75rem; color: var(--muted); }
  .mono { font-family: ui-monospace, monospace; }

  /* Monitor tab */
  .monitor-view { display: flex; flex-direction: column; gap: 20px; padding: 20px; }
  .monitor-header { display: flex; align-items: center; gap: 12px; }
  .monitor-header h2 { margin: 0; }

  .stream-indicator {
    display: flex; align-items: center; gap: 8px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: 6px; padding: 8px 12px;
    font-size: 0.85rem; color: var(--accent);
  }
  .stream-pulse {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.75); }
  }
  .stream-elapsed { margin-left: auto; font-family: monospace; font-size: 0.8rem; opacity: 0.8; }

  .resource-panel { background: var(--surface); border-radius: 8px; padding: 14px 16px; }
  .resource-label { display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 8px; color: var(--muted); }
  .resource-nums { font-family: monospace; }
  .ram-bar-track { height: 10px; background: var(--border); border-radius: 5px; overflow: hidden; }
  .ram-bar-fill { height: 100%; background: var(--accent); border-radius: 5px; transition: width 0.4s ease; }
  .ram-bar-fill.ram-warn { background: #ef4444; }
  .resource-note { font-size: 0.72rem; color: var(--muted); margin: 6px 0 0; }

  .monitor-section { background: var(--surface); border-radius: 8px; padding: 14px 16px; }
  .monitor-section h3 { margin: 0 0 12px; font-size: 0.95rem; }
  .monitor-empty { color: var(--muted); font-size: 0.85rem; margin: 0; }

  .pool-table-full { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .pool-table-full th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px 8px; border-bottom: 1px solid var(--border); }
  .pool-table-full td { padding: 7px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); }
  .pool-alias-cell { font-weight: 500; }
  .pool-variant-cell { font-family: monospace; font-size: 0.78rem; color: var(--muted); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pool-tokens-cell { font-family: monospace; font-size: 0.78rem; text-align: right; }

  .log-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .log-toolbar h3 { margin: 0; font-size: 0.95rem; flex: 1; }
  .log-count { font-size: 0.75rem; color: var(--muted); font-weight: 400; }
  .pause-label { display: flex; align-items: center; gap: 4px; font-size: 0.78rem; color: var(--muted); cursor: pointer; user-select: none; }
  .log-note { font-size: 0.72rem; color: var(--muted); margin: 0 0 10px; }

  .access-log-wrap { max-height: 380px; overflow-y: auto; border-radius: 4px; border: 1px solid var(--border); }
  .access-log-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  .access-log-table th { position: sticky; top: 0; background: var(--surface); text-align: left; color: var(--muted); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .access-log-table td { padding: 5px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); }
  .log-row-err td { background: color-mix(in srgb, #ef4444 8%, transparent); }
  .log-time { font-family: monospace; white-space: nowrap; color: var(--muted); font-size: 0.75rem; }
  .log-model { font-weight: 500; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-dur { font-family: monospace; color: var(--muted); }
  .log-tok { font-family: monospace; text-align: right; color: var(--muted); }
  .log-ok { text-align: center; font-weight: 600; }
  .log-type-badge { font-size: 0.7rem; padding: 1px 5px; border-radius: 3px; font-weight: 600; }
  .log-type-chat { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .log-type-audio { background: color-mix(in srgb, #a855f7 18%, transparent); color: #a855f7; }
  .log-type-audit { background: color-mix(in srgb, #f59e0b 18%, transparent); color: #f59e0b; }

  /* Settings view */
  .settings-view { display: flex; flex-direction: column; gap: 16px; padding: 20px; max-width: 640px; }
  .settings-view h2 { margin: 0 0 4px; }
  .settings-section { background: var(--surface); border-radius: 8px; padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
  .settings-section h3 { margin: 0; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .setting-row-indent { padding-left: 16px; }
  .setting-info { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .setting-name { font-size: 0.9rem; font-weight: 500; }
  .setting-desc { font-size: 0.77rem; color: var(--muted); line-height: 1.4; }
  .setting-loading { color: var(--muted); font-size: 0.85rem; flex-shrink: 0; }
  .settings-view select { padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 0.85rem; cursor: pointer; min-width: 140px; flex-shrink: 0; }

  /* Toggle switch */
  .toggle-switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; flex-shrink: 0; }
  .toggle-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .toggle-track { display: inline-block; width: 40px; height: 22px; background: var(--border); border-radius: 11px; transition: background 0.2s; position: relative; flex-shrink: 0; }
  .toggle-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; background: white; border-radius: 50%; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.25); }
  .toggle-switch input:checked ~ .toggle-track { background: var(--accent); }
  .toggle-switch input:checked ~ .toggle-track::after { transform: translateX(18px); }

  /* Theme toggle */
  .theme-toggle-group { display: flex; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); flex-shrink: 0; }
  .theme-option { padding: 5px 16px; border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 0.85rem; transition: background 0.15s, color 0.15s; }
  .theme-option.active { background: var(--accent); color: white; }

  /* Network config */
  .setting-note { font-size: 0.77rem; color: var(--muted); margin: 0; }
  .setting-col { display: flex; flex-direction: column; gap: 8px; }
  .port-input { width: 80px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-size: 0.85rem; text-align: right; }
  .radio-option { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; cursor: pointer; }
  .custom-bind-input { padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-size: 0.85rem; }
  .badge-recommend { font-size: 0.7rem; padding: 1px 5px; border-radius: 3px; background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); font-weight: 600; }
  .warning-banner { padding: 8px 12px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent); background: color-mix(in srgb, var(--warning) 10%, transparent); color: var(--warning); font-size: 0.8rem; }

  /* Keyboard shortcuts modal */
  .shortcuts-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: grid; place-items: center; z-index: 1000; }
  .shortcuts-backdrop { position: absolute; inset: 0; background: transparent; border: none; cursor: default; }
  .shortcuts-dialog { position: relative; z-index: 1; background: var(--panel-bg); border: 1px solid var(--border); border-radius: 10px; width: 380px; max-height: 80vh; overflow-y: auto; }
  .shortcuts-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .shortcuts-header h3 { margin: 0; font-size: 0.95rem; }
  .shortcuts-header button { background: none; border: none; cursor: pointer; color: var(--muted); font-size: 1.2rem; line-height: 1; padding: 2px 6px; border-radius: 4px; }
  .shortcuts-header button:hover { background: var(--subtle-bg); color: var(--fg); }
  .shortcuts-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .shortcuts-table tr:hover { background: var(--subtle-bg); }
  .shortcuts-table td { padding: 7px 18px; }
  .shortcuts-table td.sk { font-family: monospace; white-space: nowrap; color: var(--accent); font-weight: 600; width: 1%; padding-right: 12px; }
</style>
