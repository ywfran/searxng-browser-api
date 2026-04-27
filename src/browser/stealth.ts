/**
 * @file browser/stealth.ts
 * Anti-detection patches injected into every Playwright page before the first
 * navigation. Targets the fingerprint signals most commonly checked by SearXNG
 * instances protected by Cloudflare or similar bot-detection layers.
 */

import type { Page } from "playwright";

/**
 * JavaScript snippet executed in the browser context of every frame before any
 * HTML is parsed. Each patch is wrapped in its own try/catch so a single
 * failure cannot break the others.
 */
const STEALTH_SCRIPT = /* javascript */ `
(function () {
  'use strict';

  // 1. Remove the webdriver flag that all automation frameworks set.
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch {}

  // 2. Populate window.chrome so sites that probe it think they're in a real
  //    Chrome tab, not a headless context where the object is absent.
  try {
    if (!window.chrome) {
      window.chrome = {
        app: { isInstalled: false, getDetails: () => {}, getIsInstalled: () => {} },
        runtime: {
          connect:              () => {},
          sendMessage:          () => {},
          onConnect:            { addListener: () => {} },
          onMessage:            { addListener: () => {} },
          PlatformOs:           { MAC: 'mac', WIN: 'win', LINUX: 'linux' },
          PlatformArch:         { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
          RequestUpdateCheckStatus: {
            THROTTLED: 'throttled',
            NO_UPDATE: 'no_update',
            UPDATE_AVAILABLE: 'update_available',
          },
          OnInstalledReason:       { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        },
        loadTimes: function () {
          return {
            requestTime:            performance.timing.navigationStart / 1000,
            startLoadTime:          performance.timing.navigationStart / 1000,
            commitLoadTime:         performance.timing.responseStart   / 1000,
            finishDocumentLoadTime: performance.timing.domContentLoadedEventEnd / 1000,
            finishLoadTime:         performance.timing.loadEventEnd    / 1000,
            firstPaintTime:         performance.timing.loadEventEnd    / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType:         'Other',
            wasFetchedViaSpdy:      false,
            wasNpnNegotiated:       false,
            npnNegotiatedProtocol:  'unknown',
            wasAlternateProtocolAvailable: false,
            connectionInfo:         'http/1.1',
          };
        },
        csi: function () {
          return {
            startE:  performance.timing.navigationStart,
            onloadT: performance.timing.loadEventEnd,
            pageT:   performance.now(),
            tran:    15,
          };
        },
      };
    }
  } catch {}

  // 3. Populate navigator.plugins with realistic PDF-viewer entries.
  //    An empty plugin list is a reliable headless indicator.
  try {
    const makePlugin = (name, filename, desc, mimeTypes) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperty(plugin, 'name',        { value: name });
      Object.defineProperty(plugin, 'filename',    { value: filename });
      Object.defineProperty(plugin, 'description', { value: desc });
      Object.defineProperty(plugin, 'length',      { value: mimeTypes.length });
      mimeTypes.forEach((mt, i) => {
        const mimeType = Object.create(MimeType.prototype);
        Object.defineProperty(mimeType, 'type',          { value: mt.type });
        Object.defineProperty(mimeType, 'suffixes',      { value: mt.suffixes });
        Object.defineProperty(mimeType, 'description',   { value: mt.description });
        Object.defineProperty(mimeType, 'enabledPlugin', { value: plugin });
        plugin[i] = mimeType;
      });
      return plugin;
    };
    const fakePlugins = [
      makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format',
        [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }]),
      makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format',
        [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }]),
    ];
    const pluginArray = Object.create(PluginArray.prototype);
    fakePlugins.forEach((p, i) => { pluginArray[i] = p; });
    Object.defineProperty(pluginArray, 'length', { value: fakePlugins.length });
    pluginArray.item      = (i) => fakePlugins[i];
    pluginArray.namedItem = (n) => fakePlugins.find(p => p.name === n) || null;
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });
  } catch {}

  // 4. Language list — must match the Accept-Language header sent by the context.
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
  } catch {}

  // 5. Permissions API — the default headless response to a notifications query
  //    differs from a real browser, which some scripts detect.
  try {
    const origQuery = window.navigator.permissions.query.bind(navigator.permissions);
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(params);
    };
  } catch {}

  // 6. WebGL vendor / renderer — headless Chrome reports "Google SwiftShader"
  //    which is a well-known bot signal. Mask with plausible Intel GPU strings.
  try {
    const patchGetParameter = (proto) => {
      const original = proto.getParameter;
      proto.getParameter = function (param) {
        if (param === 37445) return 'Intel Inc.';               // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return original.call(this, param);
      };
    };
    patchGetParameter(WebGLRenderingContext.prototype);
    patchGetParameter(WebGL2RenderingContext.prototype);
  } catch {}

  // 7. Canvas fingerprint noise — add a single-pixel perturbation so every
  //    context produces a unique hash, defeating canvas fingerprint trackers.
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type, ...args) {
      if (this.width > 16 && this.height > 16) {
        const ctx2d = this.getContext('2d');
        if (ctx2d) {
          const imgData = ctx2d.getImageData(0, 0, 1, 1);
          imgData.data[0] = (imgData.data[0] + 1) & 0xff;
          ctx2d.putImageData(imgData, 0, 0);
        }
      }
      return origToDataURL.call(this, type, ...args);
    };
  } catch {}

  // 8. Remove ChromeDriver / CDP global artifacts.
  try {
    ['cdc_adoQpoasnfa76pfcZLmcfl_Array',
     'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
     'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
     '__playwright',
     '__pw_manual',
     '__PW_inspect',
    ].forEach(p => { try { delete window[p]; } catch {} });
  } catch {}

  // 9. Simulate a non-trivial navigation history (length ≤ 1 is a bot signal).
  try {
    if (history.length <= 1) {
      Object.defineProperty(history, 'length', {
        get: () => Math.floor(Math.random() * 5) + 2,
      });
    }
  } catch {}

  // 10. Hardware concurrency and device memory — headless defaults are often 2/0.
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
  } catch {}

  // 11. Screen colour depth — headless may report 24 but pixel depth can differ.
  try {
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  } catch {}

  // 12. AudioContext noise — some fingerprint scripts hash the audio output.
  //     Inject imperceptible noise (±1e-7) to vary the hash per context.
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function (channel) {
        const data = origGetChannelData.call(this, channel);
        if (data.length > 0) {
          data[0] = data[0] + Math.random() * 2e-7 - 1e-7;
        }
        return data;
      };
    }
  } catch {}

  // 13. Network connection info — bots often have unusual downlink / rtt values.
  try {
    const conn = navigator.connection;
    if (conn) {
      Object.defineProperty(conn, 'rtt',           { get: () => 50 });
      Object.defineProperty(conn, 'downlink',      { get: () => 10 });
      Object.defineProperty(conn, 'effectiveType', { get: () => '4g' });
      Object.defineProperty(conn, 'saveData',      { get: () => false });
    }
  } catch {}

})();
`;

/**
 * Injects all stealth patches into a Playwright page via `addInitScript`.
 * Must be called immediately after `ctx.newPage()` and before any `goto()`.
 *
 * @param page - The Playwright Page to patch.
 */
export async function applyStealthPatches(page: Page): Promise<void> {
  await page.addInitScript(STEALTH_SCRIPT);
}

/**
 * Pool of realistic Chrome / Firefox User-Agent strings targeting Linux VPS
 * environments, which is the most common deployment target for this API.
 */
const USER_AGENTS: readonly string[] = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

/**
 * Returns a random User-Agent string from the pool.
 * Called once per new BrowserContext to vary the fingerprint across contexts.
 */
export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
