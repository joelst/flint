<script lang="ts">
  // @ts-nocheck  // runes ($state etc.) are handled by Svelte compiler, not raw TS
  import { onMount } from "svelte";
  import MessageRenderer from "$lib/MessageRenderer.svelte";
  import ConversationSidebar from "$lib/ConversationSidebar.svelte";
  import type { Conversation } from "$lib/ConversationSidebar.svelte";
  import {
    initializeSDK,
    getSDKState,
    refreshModels,
    ensureAccelerators,
    getRecommendedStarterModels,
    getModel,
    getSTTModels,
    startService,
    stopService,
    downloadModel,
    type ModelInfo,
    type EpInfo,
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

  // Simple client-side navigation
  type View = "models" | "chat" | "audio" | "diagnostics" | "learn";
  let currentView = $state<View>("models");

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
  });

  // Recommended starters
  let recommendedStarters = $state([] as ModelInfo[]);
  let isLoadingRecommendations = $state(false);

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
  let attachedImage: string | null = $state(null); // base64 data url
  let isVisionModel = $derived(
    selectedModelAlias.includes("vision") ||
      selectedModelAlias.includes("multimodal") ||
      selectedModelAlias.includes("phi"),
  );

  // Personas (system prompt presets)
  let customPersonas = $state<Persona[]>([]);
  let showPersonaMenu = $state(false);
  let showPersonaManager = $state(false);
  let managerNewName = $state("");
  let managerNewPrompt = $state("");
  let editingPersona: Persona | null = $state(null);

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

  let messagesContainer = $state<HTMLDivElement | null>(null);

  // Audio state
  let isRecording = $state(false);
  let audioBlob = $state<Blob | null>(null);
  let transcription = $state("");
  let isTranscribing = $state(false);
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let sttModels = $state<ModelInfo[]>([]);

  // Sidecar logs (basic for now)
  let sidecarLogs = $state<string[]>([]);

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
          chatMessages,
          systemPrompt,
          contextTurns,
          showFullHistory,
          sidebarCollapsed,
          theme,
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
      }
    } catch {}
  }

  $effect(() => {
    // Persist on changes to chat related state
    if (selectedModelAlias || chatMessages.length > 0 || systemPrompt) {
      persistChat();
    }
  });

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
      } else if (selectedModelAlias && !selectedModel) {
        // Try to restore previous model for chat
        const existing = state.models.find(
          (m: ModelInfo) => m.alias === selectedModelAlias,
        );
        if (existing?.isCached) {
          getModel(selectedModelAlias)
            .then((fresh) => {
              selectedModel = fresh;
              chatClient = fresh.createChatClient();
              if (chatMessages.length === 0) {
                // could add welcome if wanted
              }
            })
            .catch(() => {});
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
      const ep = await startService(5272);
      updateStateFromSdk();
      statusMessage = `Service running at ${ep}`;
    } catch (e: any) {
      statusMessage = `Failed to start service: ${e?.message || e}`;
    }
  }

  async function stopLocalService() {
    try {
      await stopService();
      updateStateFromSdk();
      statusMessage = "Service stopped";
    } catch (e: any) {
      statusMessage = `Failed to stop service: ${e?.message || e}`;
    }
  }

  async function refreshServiceStatus() {
    await refreshModels();
    updateStateFromSdk();
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
      await refreshModels();
      await loadRecommendations();
    } catch (e: any) {
      statusMessage = `Accel setup: ${e?.message || "partial"}`;
    }
  }

  async function useStarterModel(model: ModelInfo) {
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
          await startService(5272);
        } catch {}
      }

      statusMessage = `${alias} ready. Switching to chat...`;
      currentView = "chat";
    } catch (e: any) {
      statusMessage = `Failed with starter: ${e?.message || e}`;
    }
  }

  async function selectAndChat(model: any) {
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
          await startService(5272);
        } catch {}
      }
    } catch (e: any) {
      statusMessage = `Failed to select: ${e?.message || e}`;
    }
  }

  async function loadAndSelect(model: any) {
    try {
      await loadModelAndMaybeStart(model);
      await selectAndChat(model);
    } catch (e: any) {
      statusMessage = `Load failed: ${e?.message || e}`;
    }
  }

  onMount(() => {
    // Subscribe to the SDK store
    unsubscribe = sdkStateStore.subscribe(syncFromStore);
    // Load conversation history
    loadConversations();
    init();

    return () => {
      if (unsubscribe) unsubscribe();
      saveConversations();
    };
  });

  // Auto-save conversations when messages change (Svelte 5 runes style)
  $effect(() => {
    if (currentConversationId && chatMessages.length > 0) {
      saveConversations();
    }
  });

  async function downloadAndTrack(model: any) {
    try {
      statusMessage = `Downloading ${model.alias}...`;
      await downloadModel(model, (p: number) => {
        statusMessage = `Downloading ${model.alias}: ${p.toFixed(1)}%`;
      });
      statusMessage = `${model.alias} downloaded`;
      await refreshModels();
    } catch (e: any) {
      statusMessage = `Download failed: ${e?.message || e}`;
    }
  }

  async function loadModelAndMaybeStart(model: any) {
    try {
      statusMessage = `Loading ${model.alias}...`;
      await sendLoadToSidecar(model); // use sidecar
      statusMessage = `${model.alias} loaded`;

      if (!state.serviceRunning) {
        try {
          await startService(5272);
          statusMessage = `${model.alias} loaded + service started`;
        } catch (e) {
          console.warn("Auto-start service failed", e);
        }
      }

      await refreshModels();
    } catch (e: any) {
      statusMessage = `Load failed: ${e?.message || e}`;
    }
  }

  // Placeholder for sidecar load - actual impl in sdk
  async function sendLoadToSidecar(model: any) {
    await loadModel(model);
  }

  async function unloadModel(model: any) {
    try {
      statusMessage = `Unloading ${model.alias}...`;
      await model.unload();
      statusMessage = `${model.alias} unloaded`;
      await refreshModels();
    } catch (e: any) {
      statusMessage = `Unload failed: ${e?.message || e}`;
    }
  }

  async function sendMessage(e: Event) {
    e.preventDefault();
    if (!chatInput.trim() || !chatClient || isStreaming) return;

    const userContent = chatInput.trim();
    chatMessages = [...chatMessages, { role: "user", content: userContent }];
    const currentPrompt = userContent;
    chatInput = "";
    isStreaming = true;
    abortController = new AbortController();

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

        const resp = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: selectedModelAlias,
            messages: inferenceMessages,
            stream: true,
          }),
        });

        const reader = resp.body?.getReader();
        const decoder = new TextDecoder();
        if (reader) {
          while (true) {
            if (abortController?.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            // Very naive SSE parsing for demo
            chunk.split("\n").forEach((line) => {
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  const delta = data.choices?.[0]?.delta?.content || "";
                  if (delta) {
                    assistantContent += delta;
                    const lastIndex = chatMessages.length - 1;
                    chatMessages[lastIndex] = {
                      ...chatMessages[lastIndex],
                      content: assistantContent,
                    };
                    chatMessages = [...chatMessages];
                    setTimeout(() => {
                      if (messagesContainer)
                        messagesContainer.scrollTop =
                          messagesContainer.scrollHeight;
                    }, 5);
                  }
                } catch {}
              }
            });
          }
        }
      } else if (chatClient) {
        // Fallback to direct client (dev only)
        const inferenceMessages = getMessagesForInference();
        for await (const chunk of chatClient.completeStreamingChat(inferenceMessages)) {
          if (abortController?.signal.aborted) break;
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
      if (!abortController?.signal.aborted) {
        const lastIndex = chatMessages.length - 1;
        chatMessages[lastIndex] = {
          ...chatMessages[lastIndex],
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
      abortController = null;
    }
  }

  function stopGeneration() {
    if (abortController) {
      abortController.abort();
      isStreaming = false;
      statusMessage = "Generation stopped by user";
    }
  }

  /**
   * Builds the messages array to send to the model.
   * 
   * Key design decisions for local inference:
   * - We NEVER mutate the full `chatMessages` (user can always see full history).
   * - We apply a sliding window based on `contextTurns` to keep token usage reasonable.
   * - System prompt is always included (or you can move it into the window).
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

    return [
      { role: 'system', content: systemPrompt },
      ...combined,
    ];
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
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      total += estimateTokens(text);
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

    const summaryMessages = [
      { role: "system", content: summaryPrompt },
      ...oldMessages.map((m: any) => ({ role: m.role, content: m.content }))
    ];

    statusMessage = "Summarizing older context...";
    let summary = "";

    try {
      const endpoint = state.endpoint;
      if (endpoint) {
        const resp = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: selectedModelAlias,
            messages: summaryMessages,
            stream: false,
            max_tokens: 600,
            temperature: 0.3,
          }),
        });
        const data = await resp.json();
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
      role: "system",
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
    input.onchange = (e: any) => {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          attachedImage = reader.result as string;
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }

  function clearImage() {
    attachedImage = null;
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

        mediaRecorder.start();
        isRecording = true;
        audioBlob = null;
        statusMessage = "Recording...";
      } catch (err) {
        statusMessage = `Mic error: ${err}`;
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

  async function doTranscribe() {
    if (!audioBlob || !state.serviceRunning || !state.endpoint) {
      statusMessage =
        "Service must be running (start via Diagnostics or load a model)";
      return;
    }

    isTranscribing = true;
    transcription = "";
    statusMessage = "Transcribing via sidecar service...";

    try {
      const endpoint = state.endpoint;
      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");
      formData.append("model", selectedModelAlias || "whisper-tiny");
      formData.append("language", "en");

      const resp = await fetch(`${endpoint}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const result = await resp.json();
      transcription = result.text || JSON.stringify(result, null, 2);
      statusMessage = "Transcription complete (via sidecar)";
    } catch (err: any) {
      transcription = `Error: ${err.message || err}`;
      statusMessage = "Transcription failed";
    } finally {
      isTranscribing = false;
    }
  }
</script>

<main class="app">
  <header class="header">
    <div class="brand">
      <strong>Flint</strong>
      <span class="tag">Foundry Local Interface</span>
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
            🖥️ {selectedModelAlias}
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
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
    </div>
  </header>

  <div class="body">
    <nav class="sidebar" class:collapsed={sidebarCollapsed}>
      <button
        class="nav-item collapse-toggle"
        onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {sidebarCollapsed ? "▶" : "◀"}
      </button>

      <button
        class="nav-item"
        class:active={currentView === "models"}
        onclick={() => (currentView = "models")}
        title="Models"
      >
        <span class="nav-icon">📦</span>
        <span class="nav-label">Models</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "chat"}
        onclick={() => (currentView = "chat")}
        title="Chat"
      >
        <span class="nav-icon">💬</span>
        <span class="nav-label">Chat</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "audio"}
        onclick={() => (currentView = "audio")}
        title="Audio"
      >
        <span class="nav-icon">🎙️</span>
        <span class="nav-label">Audio</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "diagnostics"}
        onclick={() => (currentView = "diagnostics")}
        title="Diagnostics"
      >
        <span class="nav-icon">🔍</span>
        <span class="nav-label">Diagnostics</span>
      </button>
      <button
        class="nav-item"
        class:active={currentView === "learn"}
        onclick={() => (currentView = "learn")}
        title="Learn"
      >
        <span class="nav-icon">📖</span>
        <span class="nav-label">Learn</span>
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
              <button
                onclick={ensureHardwareAccel}
                disabled={!state.ready || state.acceleratorsReady}
                >Setup/Refresh Accelerators</button
              >
            </div>

            {#if recommendedStarters.length > 0}
              <div class="recommendations">
                <h3>🚀 Recommended for your hardware</h3>
                <div class="hardware-info">
                  {state.eps.length} execution providers detected • {state.eps.filter(
                    (e) => e.isRegistered,
                  ).length} ready
                  {#if state.acceleratorsReady}
                    (accelerated){/if}
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

            {#if isLoadingModels && state.models.length === 0}
              <p>Loading catalog...</p>
            {:else}
              <div class="model-grid">
                {#each filteredModels as model (model.alias)}
                  <div class="model-card">
                    <div class="model-header">
                      <strong>{model.alias}</strong>
                      <span class="badges">
                        {#if model.isCached}<span class="badge cached"
                            >Cached</span
                          >{/if}
                        {#if model.isLoaded}<span class="badge loaded"
                            >Loaded</span
                          >{/if}
                      </span>
                    </div>

                    <div class="model-meta">
                      {#if (model as any).size}
                        <span>Size: {(model as any).size}</span>
                      {/if}
                      {#if (model as any).family}
                        <span>Family: {(model as any).family}</span>
                      {/if}
                    </div>

                    <div class="model-actions">
                      {#if selectedModelAlias === model.alias}
                        <span class="current-badge">CURRENT</span>
                      {/if}

                      {#if !model.isCached}
                        <button onclick={() => downloadAndTrack(model)}>
                          Download
                        </button>
                      {/if}

                      {#if model.isCached && !model.isLoaded}
                        <button onclick={() => loadModelAndMaybeStart(model)}
                          >Load</button
                        >
                        <button onclick={() => loadAndSelect(model)}
                          >Load & Chat</button
                        >
                      {/if}

                      {#if model.isLoaded}
                        {#if selectedModelAlias !== model.alias}
                          <button onclick={() => selectAndChat(model)}
                            >Chat with this</button
                          >
                        {/if}
                        <button onclick={() => unloadModel(model)}
                          >Unload</button
                        >
                      {/if}

                      {#if model.isCached && model.isLoaded && selectedModelAlias !== model.alias}
                        <button
                          onclick={() => selectAndChat(model)}
                          class="primary-chat">Set as Current Chat</button
                        >
                      {/if}

                      <button class="secondary" disabled>Details</button>
                    </div>
                  </div>
                {/each}
              </div>
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
              <div class="chat-header">
                <h2>Chat with {selectedModelAlias || "model"}</h2>
                <button 
                  type="button" 
                  class="compact-btn full-thread-btn"
                  onclick={() => (showFullHistory = !showFullHistory)}
                  title="Toggle between compact (recommended for inference) and full uncondensed thread"
                >
                  {showFullHistory ? '📜 Compact' : '📖 Full thread'}
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
                          {msg.isSummary ? "📝" : (msg.role === "user" ? "🧑" : "🤖")}
                          {#if msg.role !== 'system'}
                            <button 
                              type="button"
                              class="pin-btn"
                              class:pinned={!!msg.pinned}
                              title={msg.pinned ? "Unpin (this message will be subject to normal trimming)" : "Pin this message — it will always be included in context"}
                              onclick={() => {
                                msg.pinned = !msg.pinned;
                                chatMessages = [...chatMessages]; // force update
                              }}
                            >
                              {msg.pinned ? "★" : "☆"}
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
                    <div class="role">🤖</div>
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
                    onclick={() => (showPersonaMenu = !showPersonaMenu)}
                  >
                    🎭
                  </button>

                  {#if showPersonaMenu}
                    <div class="persona-menu" role="menu" tabindex="-1" onmouseleave={() => (showPersonaMenu = false)}>
                      <div class="persona-menu-header">
                        Choose persona
                        <span class="hint">({currentModelTags.join(", ")} model)</span>
                      </div>
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
                        ⚠️ High
                      </span>
                    {/if}
                  {/if}
                </div>

                {#if isVisionModel}
                  <div class="vision-attach">
                    <button
                      type="button"
                      onclick={attachImage}
                      disabled={isStreaming || !!attachedImage}>📷 Image</button
                    >
                    {#if attachedImage}
                      <span class="attached"
                        >✓ <button
                          type="button"
                          onclick={clearImage}
                          class="mini">✕</button
                        ></span
                      >
                    {/if}
                  </div>
                {/if}
              </div>

              <form class="chat-input" onsubmit={sendMessage}>
                <input
                  bind:value={chatInput}
                  placeholder="Type your message... (model is running locally)"
                  disabled={!chatClient || isStreaming}
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim() || !chatClient || isStreaming}
                >
                  {isStreaming ? "⏳" : "📤"}
                </button>
                {#if isStreaming}
                  <button type="button" onclick={stopGeneration} class="stop"
                    >🛑 Stop</button
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
                      <button type="button" onclick={closePersonaManager}>✕</button>
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

          {#if !selectedModelAlias}
            <p class="notice">
              Only STT models (via sidecar). New families appear automatically
              from catalog metadata.
            </p>
            {#if sttModels.length > 0}
              <div class="stt-models">
                <strong>Available STT models:</strong>
                {#each sttModels.slice(0, 5) as m}
                  <button onclick={() => loadAndSelect(m)} class="stt-btn"
                    >{m.alias}</button
                  >
                {/each}
              </div>
            {/if}
          {:else}
            <div class="audio-controls">
              <button onclick={toggleRecording} disabled={isTranscribing}>
                {isRecording ? "⏹ Stop Recording" : "🎤 Start Recording"}
              </button>
              <button onclick={uploadAudioFile} disabled={isTranscribing}>
                📁 Upload Audio File
              </button>
              <button
                onclick={doTranscribe}
                disabled={!audioBlob || isTranscribing}
              >
                {isTranscribing ? "Transcribing..." : "Transcribe"}
              </button>
            </div>

            {#if audioBlob}
              <div class="audio-info">
                Recorded audio ready ({(audioBlob.size / 1024).toFixed(1)} KB)
              </div>
            {/if}

            {#if transcription}
              <div class="transcription-result">
                <h3>Transcription:</h3>
                <pre>{transcription}</pre>
                <button
                  onclick={() => {
                    transcription = "";
                  }}>Clear</button
                >
              </div>
            {/if}
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
            </div>
          </div>

          <div class="logs-hint">
            <p>
              Logging is enabled in the sidecar (console + stdout). Full log
              viewer UI coming later.
            </p>
          </div>

          <div class="log-viewer">
            <h4>Recent Sidecar Logs</h4>
            <div class="log-list">
              {#each sidecarLogs as log, i}
                <div>{log}</div>
              {/each}
            </div>
            <button onclick={() => (sidecarLogs = [])}>Clear Logs</button>
          </div>

          <p class="placeholder">
            More diagnostics (logs export, cache info, etc.) coming in v0.2.
          </p>
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

            <h4>Continue.dev</h4>
            <pre>{`{
  "apiBase": "${state.endpoint}",
  "model": "your-loaded-model-alias"
}`}</pre>

            <h4>GitHub Copilot (Custom Provider)</h4>
            <pre>{`{
  "http": {
    "proxy": "${state.endpoint}"
  }
}`}</pre>

            <h4>Generic OpenAI-compatible client</h4>
            <pre>{`const openai = new OpenAI({
  baseURL: "${state.endpoint}",
  apiKey: "not-needed-for-local"
});`}</pre>
          {:else}
            <p>Start the service in Diagnostics to see live snippets.</p>
          {/if}

          <p>
            <a href="https://github.com/microsoft/Foundry-Local" target="_blank"
              >Official Foundry Local repo →</a
            >
          </p>
        </div>
      {/if}
    </section>
  </div>
</main>

<style>
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
    --button-bg: #3b82f6;
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
    --button-bg: #0d6efd;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
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
    align-items: baseline;
  }

  .brand .tag {
    font-size: 0.75rem;
    color: #888;
    font-weight: 400;
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
    background: #222;
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
    color: #666;
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
  }

  .nav-item:hover {
    background: color-mix(in srgb, var(--sidebar-bg) 70%, var(--panel-bg));
  }

  .nav-item.active {
    background: var(--panel-bg);
    color: var(--fg);
    border-left: 3px solid var(--accent);
    padding-left: 17px;
  }

  .sidebar-footer {
    margin-top: auto;
    padding: 16px 20px;
    font-size: 0.75rem;
    color: #555;
  }

  .sidebar.collapsed {
    width: 52px;
  }

  .sidebar.collapsed .nav-item {
    padding: 10px 8px;
    text-align: center;
    font-size: 1.1rem;
  }

  .sidebar.collapsed .nav-item.active {
    border-left: none;
    padding-left: 8px;
  }

  .collapse-toggle {
    font-size: 0.9rem;
    padding: 6px 8px !important;
    margin-bottom: 8px;
    opacity: 0.7;
  }

  .sidebar.collapsed .collapse-toggle {
    padding: 6px 4px !important;
  }

  .nav-icon {
    display: inline-block;
    margin-right: 8px;
    width: 1.2em;
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
    background: #1a1a1e;
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

  input {
    flex: 1;
    padding: 8px 12px;
    background: #222226;
    border: 1px solid #333;
    color: #eee;
    border-radius: 6px;
  }

  .model-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }

  .model-card {
    background: #222226;
    border: 1px solid #2f2f36;
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
    background: #333;
  }

  .badge.cached {
    background: #166534;
    color: #86efac;
  }
  .badge.loaded {
    background: #1e40af;
    color: #93c5fd;
  }

  .model-meta {
    font-size: 0.8rem;
    color: #888;
    margin-bottom: 12px;
  }

  .model-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  button {
    padding: 6px 12px;
    background: #3b82f6;
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
    background: #333;
    color: #ddd;
  }

  .notice {
    background: #2a1f1f;
    border: 1px solid #553;
    padding: 16px;
    border-radius: 8px;
    max-width: 520px;
  }

  .placeholder {
    color: #666;
    font-style: italic;
  }

  .privacy {
    margin-top: 8px;
  }

  .recommendations {
    margin: 16px 0;
    padding: 12px;
    background: #1f1f24;
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
    background: #2a2a32;
    padding: 8px 12px;
    border-radius: 6px;
    min-width: 160px;
  }

  .starter-card .actions {
    margin-top: 6px;
  }

  .hardware-info {
    font-size: 0.8rem;
    color: #888;
    margin-bottom: 8px;
  }

  .size {
    font-size: 0.7rem;
    color: #666;
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
    border-bottom: 1px solid #2a2a30;
  }

  .chat-header h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    background: #16161a;
    padding: 12px 16px;
    margin: 12px 12px 8px 12px;
    border-radius: 8px;
    border: 1px solid #2a2a30;
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
    border-left: 3px solid #64748b;
    background: #1f2937;
  }
  .summary-label {
    font-size: 0.65rem;
    color: #64748b;
    font-weight: 600;
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .message.pinned {
    border-left: 3px solid #eab308;
  }

  .pin-btn {
    font-size: 0.7rem;
    background: none;
    border: none;
    padding: 0 2px;
    margin-left: 2px;
    cursor: pointer;
    opacity: 0.5;
    color: #888;
    line-height: 1;
  }
  .pin-btn:hover {
    opacity: 1;
  }
  .pin-btn.pinned {
    color: #eab308;
    opacity: 1;
  }

  .condensed-hint {
    font-size: 0.65rem;
    font-style: italic;
    color: #64748b;
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
  }

  .persona-control {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    position: relative;
  }

  .vision-attach {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 0.85rem;
  }

  .vision-attach button {
    padding: 4px 8px;
    font-size: 0.75rem;
  }

  .attached {
    color: #4ade80;
    font-size: 0.8rem;
  }

  .mini {
    padding: 0 2px !important;
    background: none !important;
    color: #999 !important;
    font-size: 0.9rem;
  }

  .mini:hover {
    color: #f87171 !important;
  }

  .chat-input {
    display: flex;
    gap: 8px;
    padding: 12px;
    background: var(--panel-bg);
    border-top: 1px solid var(--border);
    border-radius: 0;
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
    background: #2563eb;
  }

  .chat-input button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .chat-input .stop {
    background: #dc2626 !important;
  }

  .chat-input .stop:hover {
    background: #b91c1c !important;
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
    background: #dc2626 !important;
  }

  .audio-view .audio-controls {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .audio-info {
    margin: 8px 0;
    color: #888;
  }

  .stt-models {
    margin: 12px 0;
  }
  .stt-btn {
    font-size: 0.8rem;
    padding: 4px 8px;
    margin: 2px;
    background: #333;
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
    color: #4ade80;
    font-weight: bold;
  }
  .status.stopped {
    color: #f87171;
  }

  .endpoint-display {
    font-family: monospace;
    background: #1a1a1e;
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

  .log-viewer {
    margin-top: 16px;
  }

  .log-list {
    height: 120px;
    overflow: auto;
    background: var(--panel-bg);
    padding: 4px;
    font-family: monospace;
    font-size: 0.75em;
    border: 1px solid var(--border);
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
    background: #2a2a32;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
  }

  .persona-chip {
    font-size: 0.65rem;
    background: #334155;
    color: #94a3b8;
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
    color: #888;
  }
  .context-control select {
    font-size: 0.7rem;
    background: #222226;
    border: 1px solid #444;
    color: #ccc;
    border-radius: 3px;
    padding: 1px 4px;
  }
  .context-estimate {
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    background: #1f2a1f;
    color: #4ade80;
    padding: 1px 5px;
    border-radius: 3px;
  }

  .context-model-info {
    font-size: 0.6rem;
    color: #666;
    font-family: ui-monospace, monospace;
  }

  .usage-pct {
    font-size: 0.6rem;
    color: #86efac;
    margin-left: 2px;
  }
  .usage-pct.high {
    color: #facc15;
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
  .persona-btn:hover { background: #3a3a42; }

  .persona-menu {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 100;
    margin-top: 4px;
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 260px;
    max-width: 340px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    font-size: 0.8rem;
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
    border-top: 1px solid #333;
  }
  .manage-link {
    background: none;
    border: none;
    color: #60a5fa;
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
    border: 1px solid #333;
    border-radius: 6px;
  }
  .persona-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid #2a2a30;
    gap: 8px;
  }
  .persona-row:last-child { border-bottom: none; }
  .persona-row-actions { display: flex; gap: 4px; }
  .persona-row-actions button {
    font-size: 0.7rem;
    padding: 2px 6px;
  }
  .persona-row-actions button.danger { color: #f87171; }
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
</style>
