import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');

function slice(startMarker: string, endMarker: string): string {
  const start = page.indexOf(startMarker);
  const end = page.indexOf(endMarker, start + startMarker.length);
  expect(start, startMarker).toBeGreaterThan(-1);
  expect(end, endMarker).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe('review fixes wired into the page', () => {
  it('asks with the granted dialog command and never window.confirm', () => {
    expect(page).toContain('confirm as confirmDialog');
    expect(page).toContain('from "@tauri-apps/plugin-dialog"');
    expect(page).not.toContain('globalThis.confirm(');
    expect(page).toContain('return "unavailable"');
    const bind = slice('async function commitCustomBindAddress', 'async function selectBindAddress');
    const confirmAt = bind.indexOf('await confirmExposeNetwork');
    expect(confirmAt).toBeGreaterThan(-1);
    expect(bind.slice(0, confirmAt)).not.toContain('networkBindAddress = next');
    expect(bind.indexOf('networkBindAddress = next')).toBeGreaterThan(bind.indexOf('if (!acceptedExpose)'));
    expect(page).not.toContain('bind:value={networkBindAddress}');
  });

  it('waits for an in-flight custom bind commit before Apply reads the address', () => {
    const bind = slice('async function commitCustomBindAddress', 'async function selectBindAddress');
    const reuseAt = bind.indexOf('if (customBindCommitTask) return customBindCommitTask');
    const taskAt = bind.indexOf('customBindCommitTask = task');
    const confirmAt = bind.indexOf('await confirmExposeNetwork');
    expect(reuseAt).toBeGreaterThan(-1);
    expect(taskAt).toBeGreaterThan(reuseAt);
    expect(confirmAt).toBeGreaterThan(taskAt);
    expect(bind).toContain('return false');
    expect(bind).toContain('return true');

    const apply = slice('async function applyNetworkSettings', 'function startSvc');
    const waitAt = apply.indexOf('await commitCustomBindAddress');
    const bindAt = apply.indexOf('const bind');
    const assignAt = apply.indexOf('networkBindAddress = bind');
    const restartAt = apply.indexOf('Restarting service');
    expect(waitAt).toBeGreaterThan(-1);
    expect(bindAt).toBeGreaterThan(waitAt);
    const between = apply.slice(waitAt, bindAt);
    expect(between).toContain('if (!committed) return');
    expect(assignAt).toBeGreaterThan(bindAt);
    expect(restartAt).toBeGreaterThan(assignAt);
    expect(apply.slice(0, bindAt)).toContain('customBindCommitTask');
  });

  it('enables Apply for a typed custom address that is not confirmed yet', () => {
    const dirty = slice('const networkSettingsDirty', 'function isLoopbackBind');
    expect(dirty).toContain('customBindDraft');
    expect(dirty).toContain("customBindDraft.trim() !== ''");
    expect(dirty).toContain('appliedNetworkBindAddress');

    const apply = slice('async function applyNetworkSettings', 'function startSvc');
    const waitAt = apply.indexOf('await commitCustomBindAddress');
    const bindAt = apply.indexOf('const bind');
    expect(waitAt).toBeGreaterThan(-1);
    expect(bindAt).toBeGreaterThan(waitAt);
    expect(apply.slice(0, waitAt)).toContain('customBindDraft');
    expect(apply.slice(waitAt, bindAt)).toContain('if (!committed) return');
    expect(apply.indexOf('networkBindAddress = bind')).toBeGreaterThan(bindAt);

    const start = slice('function startSvc(', 'const serviceTransitionBusy');
    expect(start).toContain('networkBindAddress || undefined');
    expect(start).not.toContain('customBindDraft');
    const startLocal = slice('async function startLocalService', 'async function stopLocalService');
    expect(startLocal).not.toContain('customBindDraft');
  });

  it('bounds a stuck benchmark exclusive-release join before claiming a new run', () => {
    const start = slice('async function startBenchmarkPreviewRun', 'async function resumeBenchmarkPreviewRun');
    const resume = slice('async function resumeBenchmarkPreviewRun', 'function stopBenchmarkPreviewRun');
    for (const body of [start, resume]) {
      const waitAt = body.indexOf('await waitForPriorExclusiveRelease()');
      const clearAt = body.indexOf('benchmarkRunInFlight = false');
      const claimAt = body.indexOf('claimNextBenchmarkExclusiveGeneration()');
      const finishAt = body.indexOf('finishBenchmarkExecution');
      expect(waitAt).toBeGreaterThan(-1);
      expect(clearAt).toBeGreaterThan(waitAt);
      expect(claimAt).toBeGreaterThan(clearAt);
      expect(finishAt).toBeGreaterThan(claimAt);
      expect(body).not.toContain('pendingExclusiveRelease.join()');
    }
    expect(page).toContain('pendingExclusiveRelease.joinWithTimeout(BENCHMARK_EXCLUSIVE_RELEASE_TIMEOUT_MS)');
    const wait = slice('async function waitForPriorExclusiveRelease', 'async function startBenchmarkPreviewRun');
    const pauseAt = wait.indexOf('retrier?.pause()');
    const joinAt = wait.indexOf('pendingExclusiveRelease.joinUntilIdle(BENCHMARK_EXCLUSIVE_RELEASE_TIMEOUT_MS)');
    const settledAt = wait.indexOf('if (settled) return null');
    const resumeAt = wait.indexOf('retrier?.resume()');
    const timeoutReturn = wait.indexOf('return error');
    expect(pauseAt).toBeGreaterThan(-1);
    expect(joinAt).toBeGreaterThan(pauseAt);
    expect(settledAt).toBeGreaterThan(joinAt);
    expect(wait.slice(joinAt, settledAt)).not.toContain('resume()');
    expect(resumeAt).toBeGreaterThan(settledAt);
    expect(timeoutReturn).toBeGreaterThan(resumeAt);
    expect(wait.slice(timeoutReturn)).toContain('if (!settled) retrier?.resume()');
  });

  it('classifies chat and accelerator targets with the shared predicates', () => {
    const chat = slice('function modelSupportsChat', 'function detectHostPlatform');
    expect(chat).toContain('endpointModelKind(m)');
    expect(chat).toContain('kind !== "speech" && kind !== "embed"');
    const slot = slice('function resolveSlotTarget', 'function slotTargetLabel');
    expect(slot).toContain('publishedAccelerationKind(');
    expect(slot).not.toContain('openvino');
    expect(page).toContain('publishedAccelerationKind({ id: entry.variantId })');
    expect(page).toContain("{poolKind ?? 'Generic'}");
  });

  it('shows an uncertain service as unknown and keeps Stop available', () => {
    expect(page).toContain('state.runtime?.service === \'unknown\'');
    expect(page).toContain('? "UNKNOWN"');
    expect(page).toContain('Service unknown');
    const stop = slice('async function stopLocalService', 'async function stopAndUnloadModels');
    expect(stop).toContain('serviceFailureMessage(');
    expect(stop).not.toContain('statusMessage = `Failed to stop service:');
    expect(page).toContain("state.runtime?.service === 'unknown'");
  });

  it('keeps long WAV work off a single UI turn and gives secondary buttons an edge', () => {
    expect(page).toContain('await decodeWavPcmYielding(arrayBuffer)');
    expect(page).toContain('await audioBufferToWav(');
    expect(page).toContain('await yieldToMainThread()');
    expect(page).toContain('--warning: #b45309');
    expect(page).toContain('--surface: var(--panel-bg)');
    expect(page).toContain('--text-muted: var(--muted)');
    expect(page).toContain('class="disabled-tip"');
    expect(page).toContain('.disabled-tip button:disabled');
    const secondary = slice('button.secondary {', '.storage-error');
    expect(secondary).toContain('background: var(--panel-bg)');
    expect(secondary).toContain('border: 1px solid color-mix(in srgb, var(--fg) 35%, var(--border))');
  });
});
