/**
 * @file browser/pool.ts
 * Playwright BrowserContext pool backed by `generic-pool`.
 *
 * Design decisions:
 * - A single Chromium process is shared across all contexts to minimise RAM/CPU.
 * - Each BrowserContext is an isolated session (separate cookies, storage, etc.).
 * - Pages are opened per-request, used, then closed; contexts are reused.
 * - Cookies are persisted per SearXNG instance origin so that challenge cookies
 *   (e.g. Cloudflare `cf_clearance`) survive across requests to the same host.
 * - Heavy resources (images, fonts, trackers) are blocked at the route level to
 *   reduce RAM usage and improve navigation speed.
 */

import { createPool, type Pool } from "generic-pool";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Cookie,
} from "playwright";
import { applyStealthPatches, randomUserAgent } from "./stealth.js";
import type { Page } from "playwright";

const MAX_CONTEXTS = Number(process.env.MAX_CONTEXTS ?? "8");
// Give context acquisition some headroom beyond the navigation timeout.
const ACQUIRE_TIMEOUT_MS =
  Number(process.env.SEARCH_TIMEOUT_MS ?? "12000") + 5_000;

// ─── BrowserPool ─────────────────────────────────────────────────────────────

/**
 * Manages a pool of Playwright BrowserContexts backed by a single Chromium
 * process. Exposes a high-level `withPage()` method that handles acquisition,
 * stealth patching, resource blocking, cookie restoration, and cleanup.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private pool: Pool<BrowserContext> | null = null;
  private contextCount = 0;

  /**
   * Per-origin cookie store.
   * Key: instance origin (e.g. "https://searxng.site").
   * Value: cookies captured after the last successful request to that origin.
   *
   * This lets authentication / challenge cookies persist across requests without
   * keeping a dedicated context open per instance.
   */
  private cookieStore = new Map<string, Cookie[]>();

  /**
   * Tracks origins for which engine preferences have already been initialised
   * (or attempted). Prevents repeated `/preferences` visits on every request
   * when an instance does not support the endpoint.
   */
  private readonly preferenceInitialized = new Set<string>();

  /**
   * Launches Chromium and creates the context pool.
   * Must be called once during application startup before any searches are made.
   */
  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--no-first-run",
        "--no-zygote",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        // Primary stealth flag — suppresses the Automation infobar.
        "--disable-blink-features=AutomationControlled",
        "--disable-features=TranslateUI,BlinkGenPropertyTrees",
        // Disable images at the engine level; individual routes also block them
        // via page.route() for defence-in-depth.
        "--blink-settings=imagesEnabled=false",
        "--window-size=1920,1080",
      ],
    });

    const browser = this.browser;

    this.pool = createPool<BrowserContext>(
      {
        create: async () => {
          const ctx = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: randomUserAgent(),
            locale: "pt-BR",
            timezoneId: "America/Sao_Paulo",
            extraHTTPHeaders: {
              "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.5",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
              DNT: "1",
              "Upgrade-Insecure-Requests": "1",
            },
            // Omitting geolocation, camera, and mic permissions reduces the
            // fingerprint surface area.
            geolocation: undefined,
            permissions: [],
            ignoreHTTPSErrors: false,
            javaScriptEnabled: true,
          });
          this.contextCount++;
          return ctx;
        },

        destroy: async (ctx) => {
          this.contextCount--;
          await ctx.close().catch(() => {});
        },

        validate: async (ctx) => {
          try {
            return ctx.browser() !== null;
          } catch {
            return false;
          }
        },
      },
      {
        max: MAX_CONTEXTS,
        min: 1, // Keep at least one warm context to avoid cold-start latency.
        acquireTimeoutMillis: ACQUIRE_TIMEOUT_MS,
        testOnBorrow: true,
        evictionRunIntervalMillis: 60_000,
        idleTimeoutMillis: 300_000, // Close idle contexts after 5 min.
        softIdleTimeoutMillis: 180_000,
      }
    );

    // Warm the pool by acquiring and immediately releasing one context.
    const warmCtx = await this.pool.acquire();
    await this.pool.release(warmCtx);
  }

  /**
   * Acquires a context from the pool, opens a stealth-patched page, calls `fn`,
   * then closes the page and returns the context to the pool.
   *
   * Cookies for `instanceUrl` are restored before the page is created and
   * captured again after `fn` completes, so challenge cookies persist.
   *
   * @param instanceUrl - Base URL of the SearXNG instance being queried.
   *                      Used as the cookie-store key (origin only).
   * @param fn          - Async callback that receives the ready Page.
   * @returns The value resolved by `fn`.
   * @throws  If the pool is uninitialised or `fn` throws.
   */
  async withPage<T>(
    instanceUrl: string,
    fn: (page: Page) => Promise<T>
  ): Promise<T> {
    if (!this.pool) throw new Error("BrowserPool not initialized");

    const origin = new URL(instanceUrl).origin;
    const ctx = await this.pool.acquire();

    // Restore saved cookies before opening the page.
    const savedCookies = this.cookieStore.get(origin);
    if (savedCookies?.length) {
      await ctx.addCookies(savedCookies).catch(() => {});
    }

    // On first use of this origin, inject engine preference cookies so the
    // instance uses the most useful web search engines regardless of its session
    // defaults. The cookies are captured into cookieStore at the end of withPage
    // and automatically restored on every subsequent request to this origin.
    const hasEnginesCookie =
      this.cookieStore.get(origin)?.some((c) => c.name === "enabled_engines") ?? false;
    if (!this.preferenceInitialized.has(origin) && !hasEnginesCookie) {
      await this.initializePreferences(ctx, origin);
    }

    const page = await ctx.newPage();
    await applyStealthPatches(page);

    // Block resource types that never contribute to search result HTML.
    // Using resourceType() catches CDN-served assets whose URLs lack file
    // extensions, which URL-pattern matching would miss.
    await page.route("**/*", (route) => {
      switch (route.request().resourceType()) {
        case "image":
        case "media":
        case "font":
        case "stylesheet":
          return route.abort();
        default:
          return route.continue();
      }
    });

    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      await this.captureAndClearCookies(ctx, origin);
      this.pool.release(ctx);
    }
  }

  /**
   * Target web search engines to activate on every SearXNG instance.
   *
   * SearXNG uses two cookies — `enabled_engines` and `disabled_engines` — to
   * override the instance's default engine configuration. Adding an engine to
   * `enabled_engines` activates it even when the instance session defaults have
   * it off. Listing an engine that is disabled in the instance's `settings.yml`
   * is harmless: the instance silently ignores unknown or admin-disabled names.
   */
  private static readonly TARGET_ENGINES: string[] = [
    "bing__general",
    "google__general",
    "duckduckgo__general",
    "brave__general",
    "brave.goggles__general",
    "qwant__general",
    "startpage__general",
    "yahoo__general",
    // News - User requested Active Set
    "duckduckgo news__news",
    "startpage news__news",
    "wikinews__news",
    "bing news__news",
    "brave.news__news",
    "google news__news",
    "reuters__news",
    "yahoo news__news",
    "qwant news__news",
    // Images - User requested Active Set
    "bing images__images",
    "brave.images__images",
    "duckduckgo images__images",
    "google images__images",
    "qwant images__images",
    "startpage images__images",
    // Files/torrents
    "kickass__files",
    "z-library__files",
    "piratebay__files",
    "solidtorrents__files",
    "bt4g__files",
    // Map
    "openstreetmap__map",
    "photon__map",
    // Music
    "genius__music",
    "mixcloud__music",
    "soundcloud__music",
    "bandcamp__music",
    "radio browser__music",
    // Social media (fediverse)
    "mastodon users__social media",
    "mastodon hashtags__social media",
    "lemmy communities__social media",
    "lemmy posts__social media",
    "peertube users__social media",
    "peertube channels__social media",
    // IT / packages
    "mdn__it",
    "github__it",
    "dockerhub__it",
    "pypi__it",
    "npm__it",
    "crates.io__it",
    "stackoverflow__it",
    "hackernews__it",
    // Science/papers
    "arxiv__science",
    "google scholar__science",
    "openairedatasets__science",
    "openairepublications__science",
    "pdbe__science",
    "pubmed__science",
  ];

  /**
   * Injects engine preference cookies into the given context so searches use
   * the most useful web engines regardless of the instance's session defaults.
   *
   * **Why cookies instead of a /preferences form POST?**
   * SearXNG stores all user preferences as individual cookies (not a single
   * "preferences" cookie). Injecting them directly is instantaneous, requires
   * no extra network round-trip, and works even when the /preferences page is
   * slow or unavailable. The cookies are captured into `cookieStore` at the
   * end of `withPage` and restored automatically on every subsequent request
   * to this origin — so this initialisation runs only once per origin.
   *
   * **Cookie format:** SearXNG uses Python's Morsel encoding where commas
   * inside cookie values are stored as `\054` (octal 44 = ASCII comma) and
   * the whole value is double-quoted.
   *
   * @param ctx    - The BrowserContext to use (shared with the upcoming search).
   * @param origin - The instance origin (e.g. "https://searxng.site").
   */
  private async initializePreferences(
    ctx: BrowserContext,
    origin: string
  ): Promise<void> {
    this.preferenceInitialized.add(origin);

    const hostname = new URL(origin).hostname;
    const expires = Math.floor(Date.now() / 1000) + 157_680_000; // 5 years

    const engineList = BrowserPool.TARGET_ENGINES.join("\\054");

    await ctx
      .addCookies([
        // Ensure our "Golden Set" of fast engines is enabled even if the instance
        // has them disabled by default.
        {
          name: "enabled_engines",
          value: `"${engineList}"`,
          domain: hostname,
          path: "/",
          expires,
          sameSite: "Lax",
        },
        // Explicitly disable slow or unreliable engines to improve response time.
        {
          name: "disabled_engines",
          value:
            '"naver__general\\054presearch__general\\054wiby__general\\054yandex__general\\054mojeek__general\\054presearch news__news\\054mojeek news__news\\054devicons__images\\054adobe stock__images\\054artic__images\\054lucide__images\\054nyaa__files\\054tokyotoshokan__files\\054apk mirror__files\\054apple app store__files\\054fdroid__files\\054google play apps__files"',
          domain: hostname,
          path: "/",
          expires,
          sameSite: "Lax",
        },
        // Enforce the simple theme — our HTML parser depends on its markup.
        {
          name: "theme",
          value: "simple",
          domain: hostname,
          path: "/",
          expires,
          sameSite: "Lax",
        },
        // Ensure GET is used for searches to avoid unnecessary POST redirects.
        {
          name: "method",
          value: "GET",
          domain: hostname,
          path: "/",
          expires,
          sameSite: "Lax",
        },
        // Ensure we get the complete, raw URL for results.
        {
          name: "url_formatting",
          value: "full",
          domain: hostname,
          path: "/",
          expires,
          sameSite: "Lax",
        },
      ])
      .catch(() => {
        // Cookie injection failed — search continues with instance defaults.
      });
  }

  /**
   * Saves any cookies set by `origin` into the cookie store, then clears all
   * cookies from the context so the next borrower starts with a clean slate
   * (except for cookies we explicitly restore via `withPage`).
   *
   * @param ctx    - The context being returned to the pool.
   * @param origin - The instance origin whose cookies should be preserved.
   */
  private async captureAndClearCookies(
    ctx: BrowserContext,
    origin: string
  ): Promise<void> {
    try {
      const cookies = await ctx.cookies(origin);
      if (cookies.length > 0) this.cookieStore.set(origin, cookies);
    } catch {
      // Context may already be closed; ignore.
    }
    await ctx.clearCookies().catch(() => {});
  }

  /**
   * Drains the pool, closes Chromium, and reinitialises everything.
   * Use this to recover from Chromium crashes or excessive memory growth.
   */
  async restart(): Promise<void> {
    if (this.pool) {
      await this.pool.drain();
      await this.pool.clear();
    }
    if (this.browser) await this.browser.close().catch(() => {});
    this.cookieStore.clear();
    this.preferenceInitialized.clear();
    await this.init();
  }

  /**
   * Removes cookie store and preference state for origins that are no longer
   * in the active instance list. Call this after every instance list refresh
   * to prevent unbounded memory growth.
   *
   * @param activeOrigins - Set of origins currently tracked by the instance pool.
   */
  pruneOrigins(activeOrigins: Set<string>): void {
    for (const origin of this.cookieStore.keys()) {
      if (!activeOrigins.has(origin)) {
        this.cookieStore.delete(origin);
        this.preferenceInitialized.delete(origin);
      }
    }
  }

  /** Gracefully shuts down the pool and closes Chromium. */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.drain();
      await this.pool.clear();
    }
    await this.browser?.close().catch(() => {});
  }

  /** Number of live BrowserContexts (created but not yet destroyed). */
  get activeContexts(): number {
    return this.contextCount;
  }

  /** Current pool size reported by generic-pool. */
  get poolSize(): number {
    return this.pool?.size ?? 0;
  }

  /** Number of contexts currently borrowed from the pool. */
  get poolBorrowed(): number {
    return this.pool?.borrowed ?? 0;
  }

  /** True once `init()` has completed successfully. */
  get isReady(): boolean {
    return this.browser !== null && this.pool !== null;
  }
}
