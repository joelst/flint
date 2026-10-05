import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInsideRoot } from '../../sidecar/byom-import.js';

const require = createRequire(import.meta.url);
const { verifyIpcContracts } = require('../../scripts/verify-ipc-contracts.cjs');

function permissionId(permission: unknown): string | null {
  if (typeof permission === 'string') return permission;
  if (permission && typeof permission === 'object' && 'identifier' in permission) {
    const id = (permission as { identifier?: unknown }).identifier;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function permissionById(permissions: unknown[], id: string) {
  return permissions.find((permission) => permissionId(permission) === id);
}

describe('renderer capability ACL', () => {
  const capability = JSON.parse(
    readFileSync(join(process.cwd(), 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
  );
  const permissions: unknown[] = capability.permissions;
  const ids = permissions.map(permissionId);

  it('is limited to the main window', () => {
    expect(capability.windows).toEqual(['main']);
  });

  it('does not grant opener, spawn, kill, or stdin-write', () => {
    expect(ids).not.toContain('opener:default');
    expect(ids).not.toContain('shell:allow-spawn');
    expect(ids).not.toContain('shell:allow-kill');
    expect(ids).not.toContain('shell:allow-stdin-write');
    expect(ids.some((id) => typeof id === 'string' && id.startsWith('opener:'))).toBe(false);
  });

  it('allows shell open for target=_blank links and keeps the plugin default url regex', () => {
    expect(ids).toContain('shell:default');
    const conf = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8'));
    expect(conf.plugins?.shell?.open).toBe(true);
  });

  it('does not grant the renderer a $RESOURCE read scope', () => {
    const scopes = permissions.filter((permission) => permissionId(permission) === 'fs:scope');
    expect(scopes).toEqual([]);
  });

  it('keeps $RESOURCE writes denied on the export write command', () => {
    const write = permissionById(permissions, 'fs:allow-write-text-file') as {
      deny?: Array<{ path?: string }>;
    };
    expect(write?.deny?.some((rule) => rule.path === '$RESOURCE/**')).toBe(true);
  });

  it('keeps renderer shell execute limited to Node version probes', () => {
    const execute = permissionById(permissions, 'shell:allow-execute') as {
      allow?: Array<{ name?: string; cmd?: string; sidecar?: boolean; args?: Array<{ validator?: string }> }>;
    };
    expect(execute?.allow).toHaveLength(2);
    for (const entry of execute.allow ?? []) {
      expect(entry.args).toEqual([{ validator: '^(-v|--version)$' }]);
    }
    const names = (execute.allow ?? []).map((entry) => entry.name);
    expect(names).toContain('binaries/node');
    expect(names).toContain('node');
  });

  it('keeps updater download-and-install for the 1.0 install UX', () => {
    expect(ids).toContain('updater:allow-check');
    expect(ids).toContain('updater:allow-download-and-install');
  });

  it('does not depend on the opener plugin crate or npm package', () => {
    const cargo = readFileSync(join(process.cwd(), 'src-tauri', 'Cargo.toml'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const lib = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'lib.rs'), 'utf8');
    expect(cargo).not.toMatch(/tauri-plugin-opener/);
    expect(pkg.dependencies['@tauri-apps/plugin-opener']).toBeUndefined();
    expect(lib).not.toMatch(/tauri_plugin_opener/);
  });
});

describe('renderer/sidecar boundary', () => {
  it('keeps IPC command allowlists synchronized', () => {
    const count = verifyIpcContracts(process.cwd(), { log() {}, error() {} });
    expect(count).toBeGreaterThan(0);
  });

  it('rejects BYOM paths that escape the cache root', () => {
    const root = join(process.cwd(), 'models');
    expect(isInsideRoot(root, join(root, 'phi'))).toBe(true);
    expect(isInsideRoot(root, join(root, '..', 'elsewhere'))).toBe(false);
    expect(isInsideRoot(root, `${root}-evil`)).toBe(false);
  });

  it('keeps the quit-flush event name synchronized', () => {
    const sdk = readFileSync(join(process.cwd(), 'src', 'lib', 'sdk.ts'), 'utf8');
    const rust = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'quit_flush.rs'), 'utf8');
    expect(sdk).toContain("QUIT_FLUSH_EVENT = 'flint-quit-flush'");
    expect(rust).toContain('QUIT_FLUSH_EVENT: &str = "flint-quit-flush"');
  });

  it('keeps the frontend and native runtime frame limits synchronized', () => {
    const sdk = readFileSync(join(process.cwd(), 'src', 'lib', 'sdk.ts'), 'utf8');
    const rust = readFileSync(
      join(process.cwd(), 'src-tauri', 'src', 'runtime_manager.rs'),
      'utf8',
    );
    expect(sdk).toContain('NATIVE_RUNTIME_MAX_FRAME_BYTES = 80 * 1024 * 1024');
    expect(rust).toContain('MAX_RUNTIME_FRAME_BYTES: usize = 80 * 1024 * 1024');
  });

  it('keeps generic web access out of the Foundry sidecar', () => {
    const sidecar = readFileSync(
      join(process.cwd(), 'sidecar', 'foundry-sidecar-main.js'),
      'utf8',
    );
    const sdk = readFileSync(join(process.cwd(), 'src', 'lib', 'sdk.ts'), 'utf8');
    expect(sidecar).not.toContain('fetchUrl');
    expect(sidecar).not.toContain('Readability');
    expect(sidecar).not.toContain('jsdom');
    expect(sdk).toContain("'web_tool_execute'");
  });

  it('runs the web helper with bounded pipes and a cleared environment', () => {
    const rust = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'web_tool.rs'), 'utf8');
    expect(rust).toContain('command.env_clear()');
    expect(rust).toContain('const MAX_OUTPUT_BYTES: usize = 256 * 1024');
    expect(rust).toContain('const MAX_IMAGE_OUTPUT_BYTES: usize = 2_200_000');
    expect(rust).toContain('fn output_byte_limit');
    expect(rust).toContain('const HELPER_TIMEOUT: Duration = Duration::from_secs(15)');
    expect(rust).toContain('.join("web-tool.js")');
  });

  it('bounds process-wide web helper concurrency before spawning children', () => {
    const rust = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'web_tool.rs'), 'utf8');
    expect(rust).toContain('MAX_CONCURRENT_HELPERS');
    expect(rust).toContain('ACTIVE_HELPERS');
    expect(rust).toContain('Too many web requests are already running');
  });

  it('releases the settled tool-call request ID before awaiting retrieval', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    const round = page.slice(page.indexOf('webRoundStarted = true;'), page.indexOf('const executed = await executeWebToolCalls('));
    expect(round).toContain('releaseSettledRequestId();');
    expect(page).toMatch(/function releaseSettledRequestId\(\) \{[\s\S]*?stream\.requestId = null;[\s\S]*?activeStreamRequestId = null;/);
    const imageAt = page.indexOf('const image = await executeWebImage(');
    const textAnswerAt = page.indexOf('assistantContent = data?.choices?.[0]?.message?.content || assistantContent;');
    expect(page.lastIndexOf('releaseSettledRequestId();', imageAt)).toBeGreaterThan(textAnswerAt);
  });

  it('lets an allowed model request search after the message is sent', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    const tools = readFileSync(join(process.cwd(), 'src', 'lib', 'web-tools.ts'), 'utf8');
    expect(page).not.toContain('aria-label="Search the web"');
    expect(page).not.toContain('search-web-btn');
    expect(page).not.toContain('sendMessage(event, "search")');
    expect(page).toContain('id="web-tools-enabled"');
    expect(page).toContain('class="composer-settings-btn"');
    expect(page).toContain('conversationListCollapsed = $state(true)');
    expect(page).toContain('collapsed={conversationListCollapsed}');
    const sidebar = readFileSync(join(process.cwd(), 'src', 'lib', 'ConversationSidebar.svelte'), 'utf8');
    expect(sidebar).toContain('aria-label="Show conversations"');
    expect(sidebar).toContain('aria-label="Hide conversations"');
    expect(sidebar).toContain('title="Hide"');
    expect(sidebar).toContain('name="panel-left"');
    expect(sidebar).toContain('title={exportBusy ? "Saving…" : "Export"}');
    expect(sidebar).toContain('name="download"');
    expect(page).toContain('let offerWebTools = allowWebTools');
    expect(tools).toContain("name: 'web_search'");
    expect(tools).toContain('userSearchContext(result)');
    expect(tools).toContain('searchResultUrls(result.results)');
    expect(tools).not.toContain('The model cannot start a web search');
    expect(page).not.toContain('Search the web for:');
    expect(page).not.toContain('Understood. I will treat those search results');
    const commitAt = page.indexOf('chatMessages = stamped;');
    const approvalAt = page.indexOf('const choice = await askSearchApproval(query, webTextInRequest)');
    expect(commitAt).toBeGreaterThan(0);
    expect(approvalAt).toBeGreaterThan(commitAt);
    expect(page).toContain('Allow this public web search?');
    expect(page).toContain('Just this search');
    expect(page).toContain('This query was written after the model read web content.');
    expect(page).toContain('Flint-Web-Tool/1.0');
    expect(page).toContain('Images on the page may be fetched.');
    expect(page).toContain('This host is blocked on this device.');
    expect(page).toContain('supportsToolCalling === false');
    expect(page).toContain('This model does not report tool calling.');
    expect(page).toContain('webToolsForNewChats');
    expect(page).toContain('This does not clear the blocklist or the new-chat default.');
    expect(page).toContain('if (event.key === "Escape")');
    expect(tools).toContain("name: 'web_fetch'");
    expect(tools).not.toContain("name: 'web_image'");
    expect(page).toContain('Allow all URLs');
    expect(page).toContain('askDomainApproval(host, url, originId ?? "", hop === "redirect")');
    expect(page).toContain('hop: "request" | "redirect"');
    expect(page).toContain('webToolRounds < maxWebToolRounds');
    expect(page).toContain('authorizeSearch');
    expect(page).toContain('webConsentQueue = [...webConsentQueue, { kind: "search"');
    expect(page).toContain('webConsentQueue = [...webConsentQueue, { kind: "domain"');
    // The opener is saved before the shell becomes inert. Inert moves focus
    // before the dialog effect can read document.activeElement.
    expect(page).toMatch(/rememberConsentReturnFocus\(\);\r?\n\s+webConsentQueue = \[\.\.\.webConsentQueue, \{ kind: "search"/);
    expect(page).toMatch(/rememberConsentReturnFocus\(\);\r?\n\s+webConsentQueue = \[\.\.\.webConsentQueue, \{ kind: "domain"/);
    expect(page).toContain('<main class="app" inert={webConsentPrompt ? true : undefined}>');
    const mainEnd = page.indexOf('</main>');
    const consentAt = page.indexOf('class="web-consent-overlay"');
    expect(mainEnd).toBeGreaterThan(0);
    expect(consentAt).toBeGreaterThan(mainEnd);
    expect(page.slice(consentAt, page.indexOf('web-consent-actions', consentAt))).not.toContain('persona-modal-overlay');
    expect(page).toMatch(/\.web-consent-overlay \{[^}]*z-index:\s*10000;/);
    const personaMenuZ = Number(page.match(/\.persona-menu \{[^}]*z-index:\s*(\d+);/)?.[1]);
    const shortcutsZ = Number(page.match(/\.shortcuts-overlay \{[^}]*z-index:\s*(\d+);/)?.[1]);
    expect(personaMenuZ).toBeLessThan(10000);
    expect(shortcutsZ).toBeLessThan(10000);
    expect(page).toContain('webConsentQueue.slice(1)');
    expect(page).toContain('splitCoveredConsentPrompts(');
    expect(page).toContain('allUrlsGranted(sessionWebConsent, originId ?? "")');
    expect(page).toContain('allUrlsByConversation');
    expect(page).not.toContain('webConsentPrompt = {');
    expect(page).toContain('resultUrlsForConversation(sessionWebConsent, threadLoadedFor ?? "")');
    expect(page).toContain('rememberResultUrls(sessionWebConsent, originId ?? "", resultUrls)');
    expect(page).not.toContain('searchResultUrls(result.results)');
    expect(page).not.toContain('packed.sources.map((source) => source.url).join');
    expect(page).toContain('dialogTabTrap(');
    expect(page).toContain('consentKeyGate(');
    expect(page).toContain('consentPointerAllows(');
    expect(page).toContain('latchConsentPointer(');
    expect(page).toContain('releaseConsentKey(');
    expect(page).toContain('consentHeldKeys.size > 0 ? dialog : (grantButton ?? dialog)');
    expect(page).toContain('void tick().then(');
    expect(page).toContain('restoreDialogFocus(back, [');
    expect(page).toContain('form button.stop');
    expect(page).toContain('until the page reloads.');
    expect(page).toContain('allUrlsGrantTarget(');
    expect(page).toContain('Allow all URLs in {webConsentGrantTarget.label}');
    expect(page).toContain('This request is from that conversation, not the one open now.');
    expect(page).not.toContain('every public site in this conversation');
    expect(page).not.toContain('until you quit Flint');
    expect(page).toContain('loadStoredWebConsent(');
    expect(page).toContain('saveStoredWebConsent(');
    expect(page).toContain('Could not save web approvals on this device. The previous choice is unchanged.');
    expect(page).toContain('if (!persistWebConsent(emptyStoredWebConsent())) return;');
    expect(page).toContain('splitCoveredConsentPrompts(storedWebConsent, sessionWebConsent, webConsentQueue.slice(1))');
    expect(page).not.toContain('localStorage.getItem(WEB_CONSENT_STORAGE_KEY)');
    expect(page).not.toContain('localStorage.setItem(WEB_CONSENT_STORAGE_KEY');
    expect(page).toContain('searchScrubCorpus(requestMessages)');
    expect(page).not.toContain('attachedTextFiles.map((file) => file.file?.text || "")');
  });

  it('marks manual web context untrusted and keeps image sends off the fetch tool', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    const helper = readFileSync(join(process.cwd(), 'sidecar', 'web-tool.js'), 'utf8');
    const tools = readFileSync(join(process.cwd(), 'src', 'lib', 'web-tools.ts'), 'utf8');
    const sdk = readFileSync(join(process.cwd(), 'src', 'lib', 'sdk.ts'), 'utf8');
    expect(page).toContain('const chipFence = doneFetches.map');
    expect(page).toContain('const questionText = chipFence ?');
    expect(page).toContain('let userContent: any = text;');
    expect(page).toContain('messageContentWithFence(message.content, questionText)');
    expect(page).toContain('catalogModelForEndpointId(state.models, requestModelAlias || "")?.supportsToolCalling === false');
    expect(page).toContain('stoppedBeforeVision');
    expect(page).not.toContain('urlContextMessages');
    expect(page).not.toContain('Understood. I have read');
    expect(page).toContain('if (offerWebTools && messagesContainImages(requestMessages))');
    expect(page).not.toContain('Web search cannot be combined with an image. Remove the image, or press Send.');
    expect(page).toContain('offerWebTools = false');
    expect(page).not.toContain('disable web tools for this send');
    expect(page).toContain('This page redirects to a different site.');
    expect(helper).toContain('followCrossOriginRedirects');
    expect(helper).toContain('redirectTo');
    expect(tools).toContain("result.operation !== 'redirect'");
    expect(sdk).toContain('followCrossOriginRedirects: true');
  });

  it('preserves retrieval audits when the follow-up completion fails', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    const tools = readFileSync(join(process.cwd(), 'src', 'lib', 'web-tools.ts'), 'utf8');
    expect(page).toContain('const chipAudit = urlChipRetrievalAudit(pendingUrlFetches);');
    expect(page.indexOf('const chipAudit = urlChipRetrievalAudit(pendingUrlFetches);'))
      .toBeLessThan(page.indexOf('clearUrlFetches();', page.indexOf('chatMessages = stamped;')));
    expect(page).toContain('let webSources = [...chipAudit.sources];');
    expect(page).toContain('let webErrors = [...chipAudit.errors];');
    const recordedAt = page.indexOf('webErrors = [...webErrors, ...executed.errors];');
    const abortedAt = page.indexOf('if (requestController.signal.aborted)', recordedAt);
    expect(recordedAt).toBeGreaterThan(0);
    expect(abortedAt).toBeGreaterThan(recordedAt);
    expect(tools).toContain('errors.push(`${call.function.name}: ${message}`)');
    expect(page).toContain('webErrors = [...webErrors, ...executed.errors];');
    expect(page).not.toContain('webErrors = executed.errors;');
    const audit = readFileSync(join(process.cwd(), 'src', 'lib', 'web-audit.ts'), 'utf8');
    expect(audit).toContain('title: chip.title || chip.finalUrl || chip.url');
    expect(audit).toContain('url: chip.finalUrl || chip.url');
    expect(audit).toContain('The page contained no readable text');
    expect(page).toContain('finalUrl: result.url');
    expect(page).toContain('truncated: result.truncated');
    const envelope = readFileSync(join(process.cwd(), 'src', 'lib', 'web-envelope.ts'), 'utf8');
    expect(envelope).toContain('the page content above is a truncated prefix');
    expect(page).not.toContain('const anyTruncated = doneFetches.some');
    expect(page).toContain('doneFetches.map((fetch) => fetch.url)');
    expect(page).toContain('webSources = [...webSources, ...executed.sources]');
    // The audit is stored beside the model's Markdown, never concatenated into it: an unclosed
    // comment, fence, or block in untrusted output would otherwise hide or restyle it.
    expect(page).not.toMatch(/appendWeb(Source|Error)Audit/);
    expect(page).toContain('const webAudit = buildWebAudit(sources, webErrors, webQueries);');
    expect(page.match(/\.\.\.webAuditPatch\(\)/g)?.length).toBe(7);
    expect(page).toMatch(/isError: true,\s*content: failureMessage,\s*\.\.\.webAuditPatch\(\)/);
    expect(page).toContain('updateAssistantMessage({ content: assistantContent, ...webAuditPatch() });');
    expect(page).toContain('webAudit={msg.webAudit}');
    expect(page).toContain('if (webSources.length > 0 || webErrors.length > 0)');
    expect(page).toContain('{ webToolsEnabled: includeWebToolInstruction }');
    expect(page).not.toContain('if (sourceIndex) effectiveSystem');
    expect(page).toContain('WEB_SOURCE_INDEX_NOTE');
    expect(page).toContain('fenceWebSourceIndex(');
    const fenceAt = page.indexOf('prependTextToLatestUser(');
    const packAt = page.indexOf('packContextMessages({', fenceAt);
    expect(fenceAt).toBeGreaterThan(0);
    expect(packAt).toBeGreaterThan(fenceAt);
    expect(page).toContain('requestCarriesTextAttachment(stamped)');
    expect(page).not.toContain('webFenceForVision');
    expect(page).toContain('toolContentsWithCloser(requestMessages, sendCloser)');
    expect(page).not.toContain('const visionBase');
    expect(page).toContain('withVisionImage(visionHistoryThroughLatestUser(requestMessages), toolContentsWithCloser(requestMessages, sendCloser), jpeg)');
  });

  it('retires every staged URL fetch attempt when a send commits', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    // A fetch still in flight at send time would otherwise patch its chip to done afterwards,
    // turning that page into context and fetch authority for the next message.
    expect(page).not.toContain('if (doneFetches.length > 0) clearUrlFetches();');
    expect(page).toMatch(/chatMessages = stamped;\s*(?:\/\/[^\n]*\n\s*)*clearUrlFetches\(\);/);
    expect(page).toMatch(/function clearUrlFetches\(\) \{\s*pendingUrlFetches = \[\];/);
    expect(page).toMatch(/function patchUrlFetch\(attempt: number[^)]*\) \{\s*const i = pendingUrlFetches\.findIndex\(f => f\.attempt === attempt\);\s*if \(i < 0\) return;/);
  });

  it('renders the web audit outside the model Markdown sink', () => {
    const renderer = readFileSync(join(process.cwd(), 'src', 'lib', 'MessageRenderer.svelte'), 'utf8');
    expect(renderer.match(/\{@html /g)?.length).toBe(1);
    const markdownEnd = renderer.indexOf('{@html renderedHtml}');
    const audit = renderer.indexOf('<section class="web-audit"');
    expect(markdownEnd).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(markdownEnd);
    expect(renderer).toContain('normalizeWebAudit(webAudit)');
    expect(renderer).toContain('stripChatTemplateSpill(messageClipboardText(content))');
    expect(renderer).toContain('messageClipboardWithWebAudit(copied, webAuditView)');
  });
});
