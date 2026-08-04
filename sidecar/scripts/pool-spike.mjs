#!/usr/bin/env node
/**
 * Model pool spike — investigation script for MVP 0.3 item 1.
 *
 * Question: when two chat-class models are loaded into Foundry Local back-to-back,
 * does Foundry keep both resident, or does the second load silently evict the first?
 *
 * This script answers that question by:
 *  1. Loading model A and confirming isLoaded.
 *  2. Loading model B and re-checking model A.isLoaded (the eviction signal).
 *  3. Starting the OpenAI-compatible web service.
 *  4. Routing chat requests by alias to A, then B, then A again, recording timing
 *     and isLoaded state between each step.
 *  5. Snapshotting process memory at every step.
 *  6. Writing a structured report (JSON + markdown) under docs/pool-spike-results/.
 *
 * Usage:
 *   node sidecar/scripts/pool-spike.mjs --list
 *   node sidecar/scripts/pool-spike.mjs <aliasA> <aliasB> [--port 5273] [--ep <name>] [--register-eps]
 *
 * Flags:
 *   --list           List the catalog aliases visible to the SDK and exit.
 *                    Use this first if you are not sure which aliases exist.
 *   --port N         Port for the local OpenAI-compatible service (default 5273).
 *   --ep <name>      Force a preferred execution provider before catalog.getModel
 *                    (e.g. "cuda-gpu", "directml-npu"). Required when you have
 *                    GPU/NPU variants downloaded but no EP is registered yet.
 *   --register-eps   Run manager.downloadAndRegisterEps() before loading. Slow
 *                    on first invocation (may download multi-GB EP packages),
 *                    but it ensures the SDK chooses a variant you actually have.
 *
 * Run from repo root. Both models must already be downloaded (use the Models
 * view in Flint or `foundry model download <alias>` first). The aliases you
 * pass are catalog aliases (e.g. `phi-4-mini`), NOT resolved variant ids
 * (`phi-4-mini-cuda-gpu:2` is a variant, not a catalog alias).
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

// -- CLI parsing -------------------------------------------------------------
const args = process.argv.slice(2);
const wantList = args.includes('--list');
if (args.includes('--help') || args.includes('-h')) {
  console.error('Usage:');
  console.error('  node sidecar/scripts/pool-spike.mjs --list');
  console.error('  node sidecar/scripts/pool-spike.mjs <aliasA> <aliasB> [--port N] [--ep <name>] [--register-eps]');
  process.exit(2);
}
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
const port = Number(flagValue('--port') || 5273);
const preferredEp = flagValue('--ep');
const registerEps = args.includes('--register-eps');

let aliasA, aliasB;
if (!wantList) {
  const positional = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = args[i - 1];
    return prev !== '--port' && prev !== '--ep';
  });
  if (positional.length < 2) {
    console.error('Need <aliasA> <aliasB> (or pass --list to enumerate catalog aliases)');
    process.exit(2);
  }
  aliasA = positional[0];
  aliasB = positional[1];
  if (aliasA === aliasB) {
    console.error('aliasA and aliasB must differ');
    process.exit(2);
  }
}

// -- SDK import (mirrors foundry-sidecar.js) ---------------------------------
async function loadSdk() {
  try {
    const mod = await import('foundry-local-sdk');
    return mod.FoundryLocalManager;
  } catch (e) {
    const sdkEntry = path
      .join(repoRoot, 'foundry-local-sdk', 'dist', 'index.js')
      .replace(/\\/g, '/');
    const fileUrl = 'file:///' + (sdkEntry.startsWith('/') ? sdkEntry.slice(1) : sdkEntry);
    const mod = await import(fileUrl);
    return mod.FoundryLocalManager;
  }
}

// -- Observation helpers -----------------------------------------------------
const startTs = Date.now();
const steps = [];

function memSnapshot() {
  const m = process.memoryUsage();
  return {
    rssMB: Math.round((m.rss / 1024 / 1024) * 10) / 10,
    heapUsedMB: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
  };
}

function record(label, data = {}) {
  const entry = {
    label,
    tMs: Date.now() - startTs,
    mem: memSnapshot(),
    ...data,
  };
  steps.push(entry);
  const printable = { ...entry };
  // Compact stdout for readability while running
  console.log(`[${String(entry.tMs).padStart(7)}ms] ${label}`,
    Object.keys(data).length ? JSON.stringify(printable) : '');
  return entry;
}

async function isLoadedFor(model) {
  if (!model) return null;
  if (typeof model.isLoaded === 'boolean') return model.isLoaded;
  if (typeof model.isLoaded === 'function') {
    try { return Boolean(await model.isLoaded()); }
    catch { return null; }
  }
  return null;
}

/**
 * Register one specific execution provider with Foundry Local. The SDK
 * exposes no "preferred EP" setter — instead, registering an EP causes the
 * catalog cache to invalidate and subsequent getModel(alias) calls to prefer
 * variants compiled for that EP. Idempotent; safe to call when already
 * registered. Returns the parsed { success, registeredEps, failedEps }.
 */
async function registerEp(manager, name) {
  if (!name || typeof manager?.downloadAndRegisterEps !== 'function') {
    return { success: false, registeredEps: [], failedEps: [name] };
  }
  // Use the names + progress callback form (see foundry-local-sdk dist).
  await manager.downloadAndRegisterEps([name], (epName, pct) => {
    if (pct === 0 || pct === 100 || pct % 25 === 0) {
      console.log(`  ep ${epName}: ${pct}%`);
    }
  });
  // Re-discover to capture the new isRegistered state.
  const eps = manager.discoverEps?.() || [];
  const match = eps.find(e => e.name === name);
  // Invalidate the catalog cache so the next getModels/getModel call re-fetches
  // with the CUDA/NPU variant IDs instead of the stale generic-cpu entries.
  // The catalog TTL is 6 hours — without this, isCached stays false for all
  // GPU variants even though the EP is now registered.
  manager.catalog?.invalidateCache?.();
  return {
    success: Boolean(match?.isRegistered),
    registeredEps: eps.filter(e => e.isRegistered).map(e => e.name),
    failedEps: match?.isRegistered ? [] : [name],
  };
}

async function timedFetch(url, init) {
  const t0 = Date.now();
  let resp, body, error;
  try {
    resp = await fetch(url, init);
    body = await resp.text();
  } catch (e) {
    error = e?.message || String(e);
  }
  return {
    ms: Date.now() - t0,
    status: resp?.status ?? null,
    ok: resp?.ok ?? false,
    body: body?.slice(0, 400) ?? null,
    error: error ?? null,
  };
}

// -- List-catalog mode -------------------------------------------------------
async function listCatalog() {
  const FManager = await loadSdk();
  // Use the same appName as the main Flint app so we share its model cache dir.
  // The spike is only run when Flint is NOT running, so there is no singleton conflict.
  const manager = FManager.create({ appName: 'flint', logLevel: 'warn' });

  // EP setup mirrors main() — without this, isCached reflects the generic-cpu
  // variant only, so any GPU/NPU variants you actually have on disk show as
  // "not cached." Honor the same --ep / --register-eps flags as the spike.
  const eps = typeof manager.discoverEps === 'function' ? (manager.discoverEps() || []) : [];
  if (eps.length) {
    console.log('Discovered execution providers:');
    for (const e of eps) {
      console.log(`  - ${e.name}${e.isRegistered ? ' (registered)' : ''}`);
    }
    console.log('');
  } else {
    console.log('No execution providers discovered. Cached flag will reflect generic-cpu only.\n');
  }
  if (registerEps && typeof manager.downloadAndRegisterEps === 'function') {
    console.log('Registering execution providers (this may download EP packages)...');
    await manager.downloadAndRegisterEps((name, pct) => {
      if (pct === 0 || pct === 100 || pct % 25 === 0) console.log(`  ep ${name}: ${pct}%`);
    });
    manager.catalog?.invalidateCache?.();
    console.log('');
  }
  if (preferredEp) {
    console.log(`Registering EP "${preferredEp}"...`);
    const epResult = await registerEp(manager, preferredEp);
    if (epResult.success) {
      console.log(`Registered. registeredEps now: [${epResult.registeredEps.join(', ')}]\n`);
    } else {
      console.log(`Registration of "${preferredEp}" did NOT report success.`);
      console.log(`Cached flag below may still reflect the generic-cpu fallback.\n`);
    }
  } else {
    console.log('Tip: pass --ep <name> with one of the EP names listed above (exact case) to register it,');
    console.log('     so "cached" reflects the variant compiled for that accelerator.\n');
  }

  const models = await manager.catalog.getModels();
  console.log(`Catalog: ${models.length} models\n`);
  console.log('alias                                          cached  task');
  console.log('---------------------------------------------- ------  ----------------------');
  for (const m of models) {
    const alias = (m.alias || '').padEnd(46);
    const cached = (m.isCached ? 'yes' : 'no').padEnd(6);
    const task = m.info?.task ?? '';
    console.log(`${alias} ${cached} ${task}`);
  }
}

// -- Main spike --------------------------------------------------------------
async function main() {
  record('init', {
    os: { platform: os.platform(), release: os.release(), totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024) },
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    nodeVersion: process.version,
    aliasA, aliasB, port, preferredEp, registerEps,
  });

  const FManager = await loadSdk();
  // Use the same appName as the main Flint app so we share its model cache dir.
  // The spike is only run when Flint is NOT running, so there is no singleton conflict.
  // webServiceUrls configures the bind address/port; startWebService() takes no args.
  const manager = FManager.create({ appName: 'flint', logLevel: 'info', webServiceUrls: `http://127.0.0.1:${port}` });
  record('sdk-loaded');

  // 0. Execution provider setup. Without this, a fresh manager session falls
  //    back to generic-cpu variant selection — which will fail if your downloaded
  //    variants are GPU/NPU.
  const eps = typeof manager.discoverEps === 'function' ? (manager.discoverEps() || []) : [];
  record('eps-discovered', { eps: eps.map(e => ({ name: e.name, registered: e.isRegistered ?? null })) });

  if (registerEps && typeof manager.downloadAndRegisterEps === 'function') {
    console.log('Registering execution providers (this may download EP packages)...');
    await manager.downloadAndRegisterEps((name, pct) => {
      if (pct === 0 || pct === 100 || pct % 25 === 0) {
        console.log(`  ep ${name}: ${pct}%`);
      }
    });
    manager.catalog?.invalidateCache?.();
    const eps2 = manager.discoverEps?.() || [];
    record('eps-registered', { eps: eps2.map(e => ({ name: e.name, registered: e.isRegistered ?? null })) });
  }

  if (preferredEp) {
    console.log(`Registering EP "${preferredEp}" (use exact SDK name from eps-discovered above)...`);
    const epResult = await registerEp(manager, preferredEp);
    record('ep-registered', epResult);
    if (!epResult.success) {
      console.warn(`  warn: registration of "${preferredEp}" reported failure. SDK may default to generic-cpu variants — load() will likely fail.`);
    }
  }

  // 1. Resolve catalog entries (size sanity)
  const catA = await manager.catalog.getModel(aliasA);
  const catB = await manager.catalog.getModel(aliasB);
  // catA.id / catB.id are the resolved variant IDs (e.g. "Phi-4-mini-instruct-cuda-gpu:5").
  // The HTTP endpoint may require the variant ID in the `model` field, not the alias.
  const modelIdA = catA.id;
  const modelIdB = catB.id;
  record('catalog-resolved', {
    aliasA: { id: modelIdA, sizeMb: catA?.info?.fileSizeMb ?? null, task: catA?.info?.task ?? null },
    aliasB: { id: modelIdB, sizeMb: catB?.info?.fileSizeMb ?? null, task: catB?.info?.task ?? null },
  });

  // 2. Start service FIRST — models must be loaded into a running service so the
  //    HTTP routing layer is aware of them. Loading before startWebService() causes
  //    the service to initialize with an empty registry and reject requests even
  //    when isLoaded() returns true.
  // startWebService() is synchronous and takes no arguments in this SDK version.
  // The bind port was set via webServiceUrls in create(). manager.urls has the
  // actual bound addresses after the call.
  manager.startWebService();
  const urls = manager.urls;
  const baseUrl = (urls[0] || `http://localhost:${port}`).replace(/\/+$/, '');
  const endpoint = `${baseUrl}/v1`;
  record('service-started', { endpoint, urls });

  // 3. Load A
  const loadAStart = Date.now();
  await catA.load();
  record('load-A-complete', {
    loadMs: Date.now() - loadAStart,
    aIsLoaded: await isLoadedFor(catA),
  });

  // 4. Load B (KEY observation: did A stay loaded?)
  const loadBStart = Date.now();
  await catB.load();
  const aIsLoadedAfterB = await isLoadedFor(catA);
  const bIsLoadedAfterB = await isLoadedFor(catB);
  record('load-B-complete', {
    loadMs: Date.now() - loadBStart,
    aIsLoaded: aIsLoadedAfterB,
    bIsLoaded: bIsLoadedAfterB,
    evictionDetected: aIsLoadedAfterB === false,
  });

  // 5. Chat against A — use the resolved variant ID, not the alias.
  //    The Foundry Local HTTP endpoint routes by model ID, not catalog alias.
  const chatA1 = await timedFetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelIdA,
      messages: [{ role: 'user', content: 'Reply with the single word: alpha' }],
      max_tokens: 16,
      stream: false,
    }),
  });
  record('chat-A-1', {
    ...chatA1,
    aIsLoaded: await isLoadedFor(catA),
    bIsLoaded: await isLoadedFor(catB),
  });

  // 6. Chat against B
  const chatB1 = await timedFetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelIdB,
      messages: [{ role: 'user', content: 'Reply with the single word: bravo' }],
      max_tokens: 16,
      stream: false,
    }),
  });
  record('chat-B-1', {
    ...chatB1,
    aIsLoaded: await isLoadedFor(catA),
    bIsLoaded: await isLoadedFor(catB),
  });

  // 7. Chat against A AGAIN — was it transparently reloaded, or never left?
  const chatA2 = await timedFetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelIdA,
      messages: [{ role: 'user', content: 'Reply with the single word: alpha' }],
      max_tokens: 16,
      stream: false,
    }),
  });
  record('chat-A-2', {
    ...chatA2,
    aIsLoaded: await isLoadedFor(catA),
    bIsLoaded: await isLoadedFor(catB),
  });

  // -- Verdict bucket --------------------------------------------------------
  const verdict = classify(steps);
  record('verdict', verdict);

  // -- Write report ----------------------------------------------------------
  const reportDir = path.join(repoRoot, 'docs', 'pool-spike-results');
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date(startTs).toISOString().replace(/[:.]/g, '-');
  const baseName = `pool-spike-${stamp}`;
  const jsonPath = path.join(reportDir, `${baseName}.json`);
  const mdPath = path.join(reportDir, `${baseName}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({ aliasA, aliasB, port, startTs, steps, verdict }, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown({ aliasA, aliasB, port, startTs, steps, verdict }));

  console.log('');
  console.log(`Wrote ${path.relative(repoRoot, jsonPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, mdPath)}`);
  console.log('');
  console.log(`Verdict: ${verdict.bucket} — ${verdict.summary}`);

  // Best-effort service shutdown (synchronous in this SDK version).
  try {
    if (typeof manager.stopWebService === 'function') manager.stopWebService();
  } catch (e) {
    console.warn('stopWebService failed (ignored):', e?.message || e);
  }
}

// -- Verdict classification --------------------------------------------------
function classify(steps) {
  const loadB = steps.find(s => s.label === 'load-B-complete');
  const chatA1 = steps.find(s => s.label === 'chat-A-1');
  const chatB1 = steps.find(s => s.label === 'chat-B-1');
  const chatA2 = steps.find(s => s.label === 'chat-A-2');

  if (loadB?.evictionDetected) {
    return {
      bucket: 'silent-eviction-detected',
      summary: 'Loading B reported A.isLoaded=false. Foundry Local does not keep both models resident; pool design must use budget-aware proactive eviction.',
    };
  }
  if (chatA1 && !chatA1.ok) {
    return {
      bucket: 'http-routing-broken',
      summary: `First chat to A failed (status=${chatA1.status}). Endpoint may only serve the most-recently-loaded model.`,
    };
  }
  if (chatB1 && !chatB1.ok) {
    return {
      bucket: 'http-routing-broken',
      summary: `Chat to B failed (status=${chatB1.status}). Endpoint did not honor model alias.`,
    };
  }
  if (chatA2 && chatA1 && chatA2.ms > chatA1.ms * 5) {
    return {
      bucket: 'lazy-reload-on-switch',
      summary: `Second call to A took ${chatA2.ms}ms vs. ${chatA1.ms}ms for the first — suggests Foundry reloaded A on demand rather than keeping it resident.`,
    };
  }
  if (chatA1?.ok && chatB1?.ok && chatA2?.ok) {
    return {
      bucket: 'optimistic-pool-works',
      summary: 'Both models served HTTP requests by alias with no eviction signal and no large reload penalty. Optimistic pool design is viable.',
    };
  }
  return {
    bucket: 'inconclusive',
    summary: 'Run did not match a known signature — inspect steps array.',
  };
}

// -- Markdown rendering ------------------------------------------------------
function renderMarkdown({ aliasA, aliasB, port, startTs, steps, verdict }) {
  const lines = [];
  lines.push(`# Model pool spike — ${new Date(startTs).toISOString()}`);
  lines.push('');
  lines.push(`- **aliasA**: \`${aliasA}\``);
  lines.push(`- **aliasB**: \`${aliasB}\``);
  lines.push(`- **port**: ${port}`);
  const init = steps.find(s => s.label === 'init');
  if (init?.os) {
    lines.push(`- **OS**: ${init.os.platform} ${init.os.release}, ${init.os.totalMemGB} GB RAM`);
    lines.push(`- **CPU**: ${init.cpu} (${init.cpuCount} cores)`);
    lines.push(`- **Node**: ${init.nodeVersion}`);
  }
  lines.push('');
  lines.push(`## Verdict`);
  lines.push('');
  lines.push(`**${verdict.bucket}** — ${verdict.summary}`);
  lines.push('');
  lines.push(`## Step-by-step`);
  lines.push('');
  lines.push('| t (ms) | label | RSS (MB) | A.isLoaded | B.isLoaded | notes |');
  lines.push('|---:|---|---:|---|---|---|');
  for (const s of steps) {
    const notes = [];
    if (s.loadMs !== undefined) notes.push(`load=${s.loadMs}ms`);
    if (s.ms !== undefined) notes.push(`http=${s.ms}ms`);
    if (s.status !== undefined && s.status !== null) notes.push(`HTTP ${s.status}`);
    if (s.error) notes.push(`ERROR: ${s.error}`);
    if (s.evictionDetected) notes.push('**eviction detected**');
    lines.push(
      `| ${s.tMs} | ${s.label} | ${s.mem.rssMB} | ${fmtBool(s.aIsLoaded)} | ${fmtBool(s.bIsLoaded)} | ${notes.join('; ')} |`
    );
  }
  lines.push('');
  lines.push(`## Notes for design`);
  lines.push('');
  lines.push(`Fill in observations and any anomalies the script did not auto-classify.`);
  lines.push('');
  return lines.join('\n');
}
function fmtBool(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  return '—';
}

// -- Entry -------------------------------------------------------------------
if (wantList) {
  listCatalog().catch((err) => {
    console.error('LIST FAILED:', err?.stack || err);
    process.exit(1);
  });
} else {
main().catch((err) => {
  console.error('SPIKE FAILED:', err?.stack || err);
  // Still try to dump whatever we collected so a partial report is useful.
  try {
    const reportDir = path.join(repoRoot, 'docs', 'pool-spike-results');
    fs.mkdirSync(reportDir, { recursive: true });
    const stamp = new Date(startTs).toISOString().replace(/[:.]/g, '-');
    const errPath = path.join(reportDir, `pool-spike-${stamp}-FAILED.json`);
    fs.writeFileSync(errPath, JSON.stringify({
      aliasA, aliasB, port, startTs, steps,
      failure: { message: err?.message || String(err), stack: err?.stack || null },
    }, null, 2));
    console.error(`Partial report: ${path.relative(repoRoot, errPath)}`);
  } catch (e2) { /* ignore */ }
  process.exit(1);
});
}
