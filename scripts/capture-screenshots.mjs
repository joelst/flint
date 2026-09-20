#!/usr/bin/env node
// Captures fresh README/docs screenshots from a running Flint dev build by
// driving the app's webview over the Chrome DevTools Protocol (CDP).
//
// Windows (implemented, verified):
//   Tauri's WebView2 is Chromium-based and speaks CDP natively once launched
//   with a remote debugging port.
//     1. $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//        .\build-local.ps1 -Command "npm run tauri dev"
//     2. node scripts/capture-screenshots.mjs
//
// macOS / Linux (planned, not yet implemented — see docs/DEVELOPMENT.md "Screenshots"):
//   Tauri uses WKWebView on macOS and WebKitGTK on Linux. Neither speaks Chrome's
//   CDP, so this script exits early with guidance on those platforms rather than
//   silently failing against the wrong protocol. A future contributor with access
//   to those platforms should add a separate capture path per docs/DEVELOPMENT.md.
//
// This intentionally uses only Node built-ins (global fetch + WebSocket, both
// stable since Node 22) so it needs no new dependency for an occasional task.

if (process.platform !== 'win32') {
  console.error(
    `capture-screenshots.mjs only implements the Windows (WebView2/CDP) capture path today.\n` +
      `See "Screenshots" in docs/DEVELOPMENT.md for the planned macOS (WKWebView/Safari remote\n` +
      `automation) and Linux (WebKitGTK remote inspector) approaches, which need a contributor\n` +
      `on those platforms to implement and verify before this script can support them.`,
  );
  process.exit(1);
}

const CDP_PORT = process.env.CDP_PORT ?? '9222';
const OUTPUT_DIR = new URL('../images/', import.meta.url);
const VIEWPORT = { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false };
const THEMES = ['dark', 'light'];

// Each entry: click the nav item matching `nav` (by .nav-label text), optionally
// then click a sub-nav/tab matching `subnav` (by visible button text), wait
// `waitMs` for the view to settle, then save a screenshot per theme as
// `<file base>-<theme>.png`.
const SHOTS = [
  { nav: 'Playground', subnav: 'Chat', file: 'flint-chat-window', waitMs: 600 },
  { nav: 'Playground', subnav: 'Voice', file: 'flint-audio-page', waitMs: 600 },
  { nav: 'Model Arena', file: 'flint-model-compare-page-1', waitMs: 600 },
  { nav: 'Models', file: 'flint-model-selection', waitMs: 600 },
  { nav: 'Monitor', file: 'flint-monitor-page', waitMs: 600 },
  { nav: 'Diagnostics', file: 'flint-diagnostics-page', waitMs: 600 },
  { nav: 'Integrations', file: 'flint-integrations-page', waitMs: 600 },
  { nav: 'Settings', file: 'flint-settings-page', waitMs: 600 },
  { nav: 'Help', file: 'flint-help-window', waitMs: 600 },
];

/** Minimal CDP client: one WebSocket, correlates requests to responses by id. */
class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();

  static async connectToFirstPage(port) {
    const targets = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
    const page = targets.find((t) => t.type === 'page');
    if (!page) {
      throw new Error(`No page target found on CDP port ${port}. Is the dev build running with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${port}?`);
    }
    const client = new CdpClient();
    await client.#open(page.webSocketDebuggerUrl);
    return client;
  }

  #open(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.addEventListener('open', () => resolve(), { once: true });
      this.#ws.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${event.message ?? event}`)), { once: true });
      this.#ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== undefined && this.#pending.has(message.id)) {
          const { resolve: resolveCall, reject: rejectCall } = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          if (message.error) {
            rejectCall(new Error(message.error.message));
          } else {
            resolveCall(message.result);
          }
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#ws.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result.result.value;
}

async function clickByText(client, { navLabelText, buttonText }) {
  const expression = navLabelText
    ? `(() => {
        const items = [...document.querySelectorAll('.nav-item')];
        const target = items.find((el) => el.querySelector('.nav-label')?.textContent.trim() === ${JSON.stringify(navLabelText)});
        if (!target) return 'not-found';
        target.click();
        return 'clicked';
      })()`
    : `(() => {
        const buttons = [...document.querySelectorAll('.playground-subnav button')];
        const target = buttons.find((el) => el.textContent.trim() === ${JSON.stringify(buttonText)});
        if (!target) return 'not-found';
        target.click();
        return 'clicked';
      })()`;
  return evaluate(client, expression);
}

async function setTheme(client, theme) {
  const current = await evaluate(client, `document.documentElement.getAttribute('data-theme')`);
  if (current === theme) return;
  const result = await evaluate(client, `(() => {
    const toggle = document.querySelector('.theme-toggle');
    if (!toggle) return 'not-found';
    toggle.click();
    return 'clicked';
  })()`);
  if (result !== 'clicked') {
    throw new Error('Could not find .theme-toggle button to switch theme — did the header markup change?');
  }
  await sleep(300);
  const after = await evaluate(client, `document.documentElement.getAttribute('data-theme')`);
  if (after !== theme) {
    // .theme-toggle only flips dark<->light; if we're still not on the target theme
    // after one click, click once more (covers an unexpected third state, if any).
    await evaluate(client, `document.querySelector('.theme-toggle')?.click()`);
    await sleep(300);
  }
}

async function main() {
  const client = await CdpClient.connectToFirstPage(CDP_PORT);
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

    for (const themeName of THEMES) {
      console.log(`Theme: ${themeName}`);
      await setTheme(client, themeName);

      for (const shot of SHOTS) {
        const navResult = await clickByText(client, { navLabelText: shot.nav });
        if (navResult !== 'clicked') {
          console.warn(`  [skip] nav item "${shot.nav}" not found — did the sidebar labels change?`);
          continue;
        }
        await sleep(shot.waitMs ?? 500);

        if (shot.subnav) {
          const subnavResult = await clickByText(client, { buttonText: shot.subnav });
          if (subnavResult !== 'clicked') {
            console.warn(`  [skip] sub-nav "${shot.subnav}" not found under "${shot.nav}"`);
            continue;
          }
          await sleep(shot.waitMs ?? 500);
        }

        const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
        const fileName = `${shot.file}-${themeName}.png`;
        const outPath = new URL(fileName, OUTPUT_DIR);
        await import('node:fs/promises').then((fs) => fs.writeFile(outPath, Buffer.from(data, 'base64')));
        console.log(`  [ok] ${fileName}`);
      }
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
