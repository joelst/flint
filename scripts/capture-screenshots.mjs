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
// macOS (implemented, verified):
//   Tauri uses WKWebView rather than CDP. Launch `npm run tauri dev`, then run
//   this script. It uses macOS Accessibility controls plus CoreGraphics and
//   captures each native app window with `screencapture`.
//
// This intentionally uses only Node built-ins (global fetch + WebSocket, both
// stable since Node 22) plus macOS system tools, so it needs no new dependency
// for an occasional task.

if (!['darwin', 'win32'].includes(process.platform)) {
  console.error(
    `capture-screenshots.mjs supports Windows (WebView2/CDP) and macOS native capture.\n` +
      `Linux WebKitGTK capture is not implemented.`,
  );
  process.exit(1);
}

import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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

const MAC_SHOTS = [
  { nav: 'Playground', subnav: 'Chat', heading: 'Chat', file: 'flint-macos-chat-window', width: 1366, height: 900, waitMs: 900 },
  { nav: 'Playground', subnav: 'Voice', heading: 'Audio Transcription', file: 'flint-macos-audio-page', width: 1366, height: 900, waitMs: 900 },
  { nav: 'Model Arena', heading: 'Model Arena', file: 'flint-macos-model-compare-page-1', width: 1366, height: 900, waitMs: 900 },
  { nav: 'Models', heading: 'Model Catalog', file: 'flint-macos-model-selection', width: 1366, height: 900, waitMs: 900 },
  { nav: 'Monitor', heading: 'Monitor', file: 'flint-macos-monitor-page', width: 1366, height: 900, waitMs: 1500 },
  { nav: 'Diagnostics', heading: 'Service & Diagnostics', file: 'flint-macos-diagnostics-page', width: 1366, height: 900, waitMs: 900 },
  { nav: 'Integrations', heading: 'Integrations', file: 'flint-macos-integrations-page', width: 1366, height: 900, waitMs: 900 },
  { nav: 'Settings', heading: 'Settings', file: 'flint-macos-settings-page', width: 1366, height: 1000, waitMs: 900 },
  { nav: 'Help', heading: 'Help', file: 'flint-macos-help-window', width: 1366, height: 900, waitMs: 900 },
];

const MAC_CONTROL_SOURCE = `
import AppKit
import ApplicationServices

let environment = ProcessInfo.processInfo.environment
guard let widthText = environment["FLINT_CAPTURE_WIDTH"],
      let heightText = environment["FLINT_CAPTURE_HEIGHT"],
      let nav = environment["FLINT_CAPTURE_NAV"],
      let expectedHeading = environment["FLINT_CAPTURE_HEADING"],
      let theme = environment["FLINT_CAPTURE_THEME"],
      let width = Double(widthText),
      let height = Double(heightText) else {
  fputs("Missing macOS capture parameters.\\n", stderr)
  exit(2)
}

let windows = (CGWindowListCopyWindowInfo(
  [.optionOnScreenOnly, .excludeDesktopElements],
  kCGNullWindowID
) as? [[String: Any]]) ?? []

guard let windowInfo = windows.first(where: {
  (($0[kCGWindowOwnerName as String] as? String) ?? "").lowercased() == "flint"
}), let pidNumber = windowInfo[kCGWindowOwnerPID as String] as? NSNumber,
   let windowNumber = windowInfo[kCGWindowNumber as String] as? NSNumber,
   let app = NSRunningApplication(processIdentifier: pid_t(pidNumber.int32Value)) else {
  fputs("Flint is not running with a visible window. Start npm run tauri dev first.\\n", stderr)
  exit(1)
}

let appElement = AXUIElementCreateApplication(app.processIdentifier)
var windowsValue: CFTypeRef?
guard AXUIElementCopyAttributeValue(
  appElement,
  kAXWindowsAttribute as CFString,
  &windowsValue
) == .success,
  let appWindows = windowsValue as? [AXUIElement],
  let window = appWindows.first else {
  fputs("Could not access Flint's window. Allow the invoking terminal Accessibility access.\\n", stderr)
  exit(1)
}

var size = CGSize(width: width, height: height)
if let sizeValue = AXValueCreate(.cgSize, &size) {
  _ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
}
var position = CGPoint(x: 80, y: 80)
if let positionValue = AXValueCreate(.cgPoint, &position) {
  _ = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, positionValue)
}
_ = AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
_ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
_ = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
usleep(300_000)

func sendKey(_ code: CGKeyCode, flags: CGEventFlags) {
  let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
  down.flags = flags
  down.post(tap: .cghidEventTap)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
  up.flags = flags
  up.post(tap: .cghidEventTap)
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
    element,
    attribute as CFString,
    &value
  ) == .success else {
    return nil
  }
  return value as? String
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
    element,
    kAXChildrenAttribute as CFString,
    &value
  ) == .success else {
    return []
  }
  return value as? [AXUIElement] ?? []
}

func matchesText(_ element: AXUIElement, expected: String) -> Bool {
  [
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
  ].contains { stringAttribute(element, $0) == expected }
}

func supportsPress(_ element: AXUIElement) -> Bool {
  var actions: CFArray?
  guard AXUIElementCopyActionNames(element, &actions) == .success,
        let names = actions as? [String] else {
    return false
  }
  return names.contains(kAXPressAction)
}

func findButton(_ element: AXUIElement, label: String) -> AXUIElement? {
  if supportsPress(element), matchesText(element, expected: label) {
    return element
  }
  for child in children(element) {
    if let match = findButton(child, label: label) {
      return match
    }
  }
  return nil
}

func containsHeading(_ element: AXUIElement, expected: String) -> Bool {
  if stringAttribute(element, kAXRoleAttribute) == "AXHeading",
     matchesText(element, expected: expected) {
    return true
  }
  for child in children(element) {
    if containsHeading(child, expected: expected) {
      return true
    }
  }
  return false
}

func pressButton(_ label: String) {
  guard let button = findButton(window, label: label),
        AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
    fputs("Could not press Flint button '\\(label)'.\\n", stderr)
    exit(1)
  }
}

func waitForHeading(_ heading: String) {
  let deadline = Date().addingTimeInterval(5)
  while Date() < deadline {
    if containsHeading(window, expected: heading) {
      return
    }
    usleep(100_000)
  }
  fputs("Timed out waiting for Flint to show heading '\\(heading)'.\\n", stderr)
  exit(1)
}

pressButton("Settings")
waitForHeading("Settings")
pressButton(theme == "dark" ? "Dark" : "Light")
usleep(300_000)

pressButton(nav)
if let subnav = environment["FLINT_CAPTURE_SUBNAV"], !subnav.isEmpty {
  usleep(300_000)
  pressButton(subnav)
}
waitForHeading(expectedHeading)
sendKey(126, flags: .maskCommand)
usleep(300_000)

print(windowNumber.uint32Value)
`;

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

async function captureWindowsScreenshots() {
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
        await writeFile(outPath, Buffer.from(data, 'base64'));
        console.log(`  [ok] ${fileName}`);
      }
    }
  } finally {
    client.close();
  }
}

async function captureMacScreenshots() {
  for (const themeName of THEMES) {
    console.log(`Theme: ${themeName}`);
    for (const shot of MAC_SHOTS) {
      const { stdout } = await execFileAsync('swift', [
        '-e',
        MAC_CONTROL_SOURCE,
      ], {
        env: {
          ...process.env,
          FLINT_CAPTURE_WIDTH: String(shot.width),
          FLINT_CAPTURE_HEIGHT: String(shot.height),
          FLINT_CAPTURE_NAV: shot.nav,
          FLINT_CAPTURE_SUBNAV: shot.subnav ?? '',
          FLINT_CAPTURE_HEADING: shot.heading,
          FLINT_CAPTURE_THEME: themeName,
        },
      });
      const windowId = stdout.trim().split(/\s+/).at(-1);
      if (!/^\d+$/.test(windowId ?? '')) {
        throw new Error(`Could not determine Flint's native window id: ${stdout.trim()}`);
      }

      await sleep(shot.waitMs);
      const fileName = `${shot.file}-${themeName}.png`;
      const outPath = new URL(fileName, OUTPUT_DIR);
      await execFileAsync('/usr/sbin/screencapture', ['-x', '-o', '-l', windowId, outPath.pathname]);
      await chmod(outPath, 0o644);
      console.log(`  [ok] ${fileName}`);
    }
  }
}

async function main() {
  if (process.platform === 'darwin') {
    await captureMacScreenshots();
    return;
  }
  await captureWindowsScreenshots();
}

main().catch((error) => {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
});
