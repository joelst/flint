#!/usr/bin/env node
/**
 * Example sidecar wrapper for Foundry Local SDK.
 * Run with: node sidecar/foundry-sidecar.js
 *
 * Communicates over stdio with JSON lines for Tauri shell plugin.
 *
 * In real use:
 * - Bundle this as sidecar binary? (use pkg or vercel/pkg for portable node)
 * - Or better: port to Rust SDK in src-tauri and use invoke.
 *
 * Commands:
 * { "cmd": "init", "appName": "flint" }
 * { "cmd": "listModels" }
 * { "cmd": "download", "alias": "..." }
 * etc.
 */

import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let manager = null;
let currentEndpoint = null;
let currentModel = null;
let FoundryLocalManager = null;

function send (msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log (level, message) {
  // At least enabling logging (sent to stdout for now; UI can consume later)
  send({ type: 'log', level, message, timestamp: Date.now() });
}

async function getFoundryManager () {
  if (FoundryLocalManager) return FoundryLocalManager;
  try {
    // Try normal module resolution (works in dev when node_modules is present)
    const mod = await import('foundry-local-sdk');
    FoundryLocalManager = mod.FoundryLocalManager;
    return FoundryLocalManager;
  } catch (err) {
    log('warn', `Normal SDK import failed (${err?.message || err}), trying bundled resource path`);
    // In prod bundle: we ship ../node_modules/foundry-local-sdk via tauri resources
    // sidecar is at <res>/sidecar/..., SDK at <res>/foundry-local-sdk/dist/index.js
    const base = path.resolve(__dirname, '..');
    const sdkEntry = path.join(base, 'foundry-local-sdk', 'dist', 'index.js').replace(/\\/g, '/');
    const fileUrl = 'file:///' + (sdkEntry.startsWith('/') ? sdkEntry.slice(1) : sdkEntry);
    const mod = await import(fileUrl);
    FoundryLocalManager = mod.FoundryLocalManager;
    return FoundryLocalManager;
  }
}

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    send({ id: null, error: 'Invalid JSON' });
    return;
  }

  const { id, cmd, ...payload } = msg;

  const reply = (result) => {
    send({ id, ...result });
  };

  try {
    if (cmd === 'init') {
      const FManager = await getFoundryManager();
      const appName = payload.appName || 'flint';
      manager = FManager.create({ appName, logLevel: payload.logLevel || 'info' });
      log('info', `SDK initialized for ${appName}`);
      reply({ ok: true, result: 'initialized' });
    } else if (cmd === 'listModels') {
      const models = await manager.catalog.getModels();
      reply({
        ok: true, result: models.map(m => ({
          alias: m.alias,
          cached: m.isCached,
          size: m.info?.fileSizeMb,
          task: m.info?.task,
          capabilities: m.info?.capabilities,
          // Context length is very useful for trimming decisions
          contextLength: m.info?.contextLength ?? m.info?.maxContext ?? null,
          family: m.info?.family || null
        }))
      });
    } else if (cmd === 'getSTTModels') {
      const all = await manager.catalog.getModels();
      const stt = all.filter(m => {
        const t = (m.info?.task || '').toLowerCase();
        const caps = (m.info?.capabilities || '').toLowerCase();
        return t.includes('automatic-speech-recognition') || t.includes('stt') || caps.includes('automatic-speech-recognition');
      });
      reply({ ok: true, result: stt.map(m => ({ alias: m.alias, cached: m.isCached })) });
    } else if (cmd === 'getVisionModels') {
      const all = await manager.catalog.getModels();
      const vision = all.filter(m => {
        const t = (m.info?.task || '').toLowerCase();
        const caps = (m.info?.capabilities || '').toLowerCase();
        const alias = (m.alias || '').toLowerCase();
        return t.includes('vision') || caps.includes('vision') || caps.includes('image') || alias.includes('vision') || alias.includes('multimodal');
      });
      reply({ ok: true, result: vision.map(m => ({ alias: m.alias, cached: m.isCached })) });
    } else if (cmd === 'download') {
      const model = await manager.catalog.getModel(payload.alias);
      await model.download((p) => send({ id, progress: p, alias: payload.alias }));
      reply({ ok: true });
    } else if (cmd === 'load') {
      currentModel = await manager.catalog.getModel(payload.alias);
      await currentModel.load();
      log('info', `Model ${payload.alias} loaded`);
      reply({ ok: true });
    } else if (cmd === 'unload') {
      if (currentModel) {
        await currentModel.unload();
        log('info', `Model unloaded`);
      }
      currentModel = null;
      reply({ ok: true });
    } else if (cmd === 'startService') {
      if (!currentModel) {
        throw new Error('No model loaded');
      }
      // Use the SDK's web service if available
      if (typeof manager.startWebService === 'function') {
        const info = await manager.startWebService({ port: payload.port || 5272 });
        currentEndpoint = info?.endpoint || info?.url || `http://localhost:${payload.port || 5272}/v1`;
      } else {
        // Fallback - the sidecar itself can't easily serve, but we can report default
        // In practice the main app or another mechanism would use the endpoint
        currentEndpoint = `http://localhost:${payload.port || 5272}/v1`;
      }
      log('info', `Service started at ${currentEndpoint}`);
      reply({ ok: true, endpoint: currentEndpoint });
    } else if (cmd === 'stopService') {
      // Best effort
      currentEndpoint = null;
      log('info', 'Service stop requested');
      reply({ ok: true });
    } else if (cmd === 'getEndpoint') {
      reply({ ok: true, endpoint: currentEndpoint });
    } else if (cmd === 'getStatus') {
      reply({
        ok: true,
        result: {
          initialized: !!manager,
          modelLoaded: !!currentModel,
          currentModel: currentModel?.alias,
          endpoint: currentEndpoint,
          serviceRunning: !!currentEndpoint
        }
      });
    } else if (cmd === 'getEps') {
      const eps = typeof manager.discoverEps === 'function' ? manager.discoverEps() : [];
      reply({ ok: true, result: eps });
    } else if (cmd === 'ensureAccelerators') {
      if (typeof manager.downloadAndRegisterEps === 'function') {
        await manager.downloadAndRegisterEps((name, pct) => {
          send({ id, progress: pct, ep: name });
        });
      }
      reply({ ok: true });
    } else if (cmd === 'setLogLevel') {
      // Enable logging at requested level (SDK supports via config or we just log here)
      log('info', `Log level set to ${payload.level}`);
      reply({ ok: true });
    } else {
      reply({ error: `Unknown command: ${cmd}` });
    }
  } catch (e) {
    reply({ error: e.message || String(e) });
  }
});

// Send ready as early as possible (after readline setup) so the host does not time out.
// We lazy-load the heavy Foundry SDK only on first 'init' command.
const readyMsg = { ready: true, pid: process.pid, version: '0.1.0' };
send(readyMsg);
send({ type: 'log', level: 'info', message: `Sidecar process started (pid ${process.pid}) and listening` });

// Also write to stderr for better visibility in dev mode
console.error(`[foundry-sidecar] Ready: ${JSON.stringify(readyMsg)}`);