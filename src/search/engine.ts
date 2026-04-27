/**
 * @file search/engine.ts
 * Core search orchestration: builds SearXNG query URLs, fans out requests across
 * multiple instances in parallel, and returns the first successful result set.
 */

import type { Page } from "playwright";
import type { BrowserPool } from "../browser/pool.js";
import type { InstancePool } from "../instances.js";
import type { SearchRequest, SearchResponse } from "../types.js";
import { parseAll, detectBlock, type ParsedPagination } from "./parser.js";
import { resultFilter } from "./filter.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of consecutive rounds where all instances return zero results
 * before the search gives up. A value of 2 means: the first round returns 0,
 * one more round is tried with fresh instances, and if that also returns 0
 * the query is assumed to have no matches.
 *
 * Hardcoded — exposing this to the caller makes no practical sense.
 */
const MAX_ZERO_ROUNDS = 2;

// ─── URL builder ──────────────────────────────────────────────────────────────

/**
 * Constructs a SearXNG search URL from the given base URL and request parameters.
 *
 * The `category_<name>=1` parameter format is used because it matches the hidden
 * inputs in SearXNG's pagination forms and is more reliable than `categories=<name>`.
 *
 * @param base - Instance base URL (e.g. "https://searxng.site").
 * @param req  - Search request parameters.
 * @returns Fully qualified search URL string.
 */
function buildSearchUrl(base: string, req: SearchRequest): string {
  const url = new URL("/search", base);

  url.searchParams.set("q", req.query);
  url.searchParams.set("language", req.language ?? "auto");
  url.searchParams.set("safesearch", String(req.safeSearch ?? 2));
  url.searchParams.set("time_range", req.timeRange ?? "");
  url.searchParams.set("theme", "simple");

  const category = req.categories ?? "general";
  url.searchParams.set(`category_${category}`, "1");

  if (req.engines?.length)
    url.searchParams.set("engines", req.engines.join(","));

  if (req.pageno && req.pageno > 1)
    url.searchParams.set("pageno", String(req.pageno));

  return url.toString();
}

// ─── Cancellation token ───────────────────────────────────────────────────────

/**
 * Shared cancellation primitive passed to all parallel search tasks.
 *
 * When `cancel()` is called (e.g. once a winner is found), every registered
 * Page is closed immediately, which causes their in-flight `page.goto()` calls
 * to throw and releases their BrowserContexts back to the pool without waiting
 * for the full navigation timeout to expire.
 */
interface CancelToken {
  /** True after `cancel()` has been called. */
  readonly cancelled: boolean;
  /**
   * Registers a Page so it will be closed on cancellation.
   * If already cancelled, closes the page immediately.
   */
  register(page: Page): void;
  /** Removes a page from the registry before its normal close. */
  unregister(page: Page): void;
  /** Closes all registered pages and marks the token as cancelled. */
  cancel(): void;
}

function makeCancelToken(): CancelToken {
  const pages = new Set<Page>();
  let cancelled = false;

  return {
    get cancelled() {
      return cancelled;
    },
    register(page: Page) {
      if (cancelled) {
        page.close().catch(() => {});
      } else {
        pages.add(page);
      }
    },
    unregister(page: Page) {
      pages.delete(page);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const p of pages) p.close().catch(() => {});
      pages.clear();
    },
  };
}

// ─── Single-instance search ───────────────────────────────────────────────────

interface InstanceSearchResult {
  results: ReturnType<typeof parseAll>["results"];
  extras: ReturnType<typeof parseAll>["extras"];
  pagination: ParsedPagination;
  instanceUrl: string;
  latencyMs: number;
}

/**
 * Executes a search against a single SearXNG instance using the browser pool.
 *
 * Handles the Cloudflare JS challenge by waiting up to 20 seconds for the
 * challenge page to resolve before re-inspecting the DOM. All other block
 * conditions cause an immediate throw so the caller can mark the instance failed.
 *
 * POST fallback: some instances reject GET requests to `/search` and redirect to
 * their homepage. When this is detected (the final URL's pathname differs from the
 * requested one), the query is re-submitted as an HTML form POST — exactly as a
 * browser would do. This is attempted at most once; if POST also redirects, the
 * instance is immediately discarded.
 *
 * Respects the shared `cancelToken` — if another instance wins the race first,
 * the token closes this page immediately, freeing the BrowserContext for the
 * next queued request instead of waiting for the navigation timeout.
 *
 * @param browserPool - The shared Playwright context pool.
 * @param instanceUrl - Base URL of the SearXNG instance to query.
 * @param req         - Search request parameters.
 * @param cancelToken - Shared cancellation token for the parallel race.
 * @throws If the instance is blocked, times out, cancelled, or returns an error page.
 */
async function searchOneInstance(
  browserPool: BrowserPool,
  instanceUrl: string,
  req: SearchRequest,
  cancelToken: CancelToken
): Promise<InstanceSearchResult> {
  const timeout = req.timeoutMs ?? 12_000;
  const searchUrl = buildSearchUrl(instanceUrl, req);
  const startTime = Date.now();

  const { results, extras, pagination } = await browserPool.withPage(
    instanceUrl,
    async (page: Page) => {
      // Register this page so it can be closed externally if another instance wins.
      cancelToken.register(page);
      if (cancelToken.cancelled) throw new Error("search_cancelled");

      // Sync user preferences (language and safesearch) into cookies to ensure
      // the instance context matches our URL parameters exactly.
      const hostname = new URL(instanceUrl).hostname;
      const expires = Math.floor(Date.now() / 1000) + 3600; // 1-hour session
      const cookies = [
        {
          name: "language",
          value: req.language ?? "auto",
          domain: hostname,
          path: "/",
          expires,
          sameSite: "Lax" as const,
        },
        {
          name: "safesearch",
          value: String(req.safeSearch ?? 2),
          domain: hostname,
          path: "/",
          expires,
          sameSite: "Lax" as const,
        },
      ];
      await page.context().addCookies(cookies).catch(() => {});

      let lastStatus = 200;
      // Tracks the HTTP status of a POST fallback response (same path, no query
      // params). Set inside the existing response listener so we avoid the
      // TypeScript overload mismatch that occurs with named listener variables.
      let postStatus = 0;

      // Capture the raw response bytes for the search URL so we can decode them
      // as UTF-8 regardless of what charset the server declares. Some SearXNG
      // instances serve UTF-8 content without a proper charset header, causing
      // Chromium to fall back to latin-1 and produce mojibake in page.content().
      // We track a Promise so the async body read doesn't block navigation.
      let rawBodyPromise: Promise<Buffer | null> | null = null;
      page.on("response", (resp) => {
        const respUrl = resp.url();
        if (respUrl === searchUrl) {
          lastStatus = resp.status();
          rawBodyPromise = resp.body().catch(() => null);
        } else {
          // Capture the status of a POST response to the same path (the POST URL
          // carries no query params, so it never equals searchUrl).
          try {
            if (new URL(respUrl).pathname === new URL(searchUrl).pathname) {
              postStatus = resp.status();
            }
          } catch {
            // Ignore unparseable response URLs.
          }
        }
      });

      const navResponse = await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout,
        referer: instanceUrl, // Add Referer to look more like a internal navigation
      });

      // Check immediately after navigation — winner may have been found while
      // we were waiting on the network.
      if (cancelToken.cancelled) throw new Error("search_cancelled");

      let status = navResponse?.status() ?? lastStatus;

      // POST fallback: some instances redirect GET /search to their homepage.
      // Detect by comparing the final URL's pathname to the expected one.
      // If redirected, re-submit as a form POST (at most once — no loops).
      const expectedPath = new URL(searchUrl).pathname;
      if (new URL(page.url()).pathname !== expectedPath) {
        const postParams = Object.fromEntries(new URL(searchUrl).searchParams);

        // Register the URL listener BEFORE triggering form.submit() to avoid
        // the race where the navigation fires before the listener is attached.
        //
        // The predicate also resolves early when postStatus signals a 3xx POST
        // response — this prevents a full timeout wait when the instance also
        // redirects the POST back to its homepage. The pathname check below then
        // throws immediately, making the failure fast instead of timing out.
        await Promise.all([
          page.waitForURL(
            (url) => (postStatus >= 300 && postStatus < 400) || url.pathname === expectedPath,
            { waitUntil: "domcontentloaded", timeout: 10_000 }
          ),
          page.evaluate(
            ({ action, params }: { action: string; params: Record<string, string> }) => {
              const form = document.createElement("form");
              form.method = "POST";
              form.action = action;
              form.style.display = "none";
              for (const [key, value] of Object.entries(params)) {
                const input = document.createElement("input");
                input.type = "hidden";
                input.name = key;
                input.value = value;
                form.appendChild(input);
              }
              document.body.appendChild(form);
              form.submit();
            },
            { action: expectedPath, params: postParams as Record<string, string> }
          ),
        ]).catch((e: unknown) => {
          throw new Error(
            `POST fallback failed: ${String((e as Error)?.message ?? e)}`
          );
        });

        // If POST also redirected (3xx detected early, or silent redirect),
        // discard this instance immediately — no loops allowed.
        if (new URL(page.url()).pathname !== expectedPath) {
          throw new Error("Instance redirected after POST fallback; not navigable");
        }

        // The raw body listener is keyed to the GET URL (with query params),
        // so it won't fire for the POST response. Fall back to page.content().
        rawBodyPromise = null;
        status = 200;
      }

      // Inspect the page immediately after navigation to decide the fast path.
      //
      // - cloudflare: the JS challenge may still resolve — give it up to 20 s.
      // - any other block (captcha, rate_limit, access_denied): the response
      //   will never improve, so throw right away instead of burning 5 s on the
      //   waitForSelector below. This is the main reason a captcha instance used
      //   to cost ~6 s per attempt; with this fast-path it costs ~1-2 s.
      // - no block: wait up to 5 s for JS-rendered results before reading HTML.
      const initialHtml = await page.content();
      const initialBlock = detectBlock(initialHtml, status);

      if (initialBlock === "cloudflare") {
        await page
          .waitForSelector("article.result", { timeout: 20_000 })
          .catch(() => {});
        // After the challenge resolves, a new navigation fires to the search URL,
        // so rawBodyPromise will have been updated with the final results body.
        status = 200;
      } else if (initialBlock) {
        // Non-Cloudflare block detected right after navigation — fail fast and
        // let the caller pick a different instance immediately.
        throw new Error(`Blocked (${initialBlock}) by ${instanceUrl}`);
      } else {
        // Clean page — wait for any JS-injected results before reading the DOM.
        await page
          .waitForSelector("article.result", { timeout: 3_000 })
          .catch(() => {});
      }

      if (cancelToken.cancelled) throw new Error("search_cancelled");

      // Prefer the raw response body (decoded as UTF-8) over page.content().
      // page.content() reflects whatever charset Chromium chose at parse time;
      // the raw body is the original bytes, which for SearXNG are always UTF-8.
      // Fall back to page.content() only when the response body is unavailable
      // (e.g. JS-only rendering or a cancelled/failed fetch).
      // TypeScript narrows rawBodyPromise to never inside closures, so we cast
      // explicitly to the declared type before awaiting.
      const rawBody: Buffer | null =
        rawBodyPromise !== null
          ? await (rawBodyPromise as Promise<Buffer | null>)
          : null;
      const html = rawBody ? rawBody.toString("utf-8") : await page.content();

      const block = detectBlock(html, status);
      if (block) throw new Error(`Blocked (${block}) by ${instanceUrl}`);

      // Parse results, extras, and pagination in a single cheerio.load() call.
      // The returned $ is reused below for the #results container check so we
      // never build the DOM tree more than once per response.
      const { results: parsedResults, extras, pagination, $ } = parseAll(html);

      if (parsedResults.length === 0) {
        const pageTitle = await page.title().catch(() => "");
        if (pageTitle.includes("Error") || pageTitle.includes("500")) {
          throw new Error(`Instance returned error page: "${pageTitle}"`);
        }

        // Detect pages that are not search result pages (e.g. a redirect to
        // the instance homepage). A valid SearXNG page — even with no matches —
        // always contains a #results container. Its absence means we navigated
        // to the wrong page (redirect, auth wall, etc.) and should fail fast
        // so a different instance is tried instead.
        // DOM-based check via the shared $ avoids false-positives from substring
        // matches in inline scripts or IDs like "search_results".
        if (!$("#results, #main_results").length) {
          throw new Error(`Not a results page (no #results container; likely redirected)`);
        }

        // Zero results inside a proper results page is a valid response.
      }

      // Deregister before withPage closes the page normally.
      cancelToken.unregister(page);

      return { results: parsedResults, extras, pagination };
    }
  );

  return { results, extras, pagination, instanceUrl, latencyMs: Date.now() - startTime };
}

// ─── Parallel race ────────────────────────────────────────────────────────────

/**
 * Fans out a search request to N SearXNG instances in parallel and returns the
 * response from the first instance that succeeds.
 *
 * All instances are allowed to complete even after a winner is found, so that
 * their success/failure metrics are recorded for future scoring. Non-fatal errors
 * from individual instances are collected in the `errors` field of the response.
 *
 * @param browserPool  - The shared Playwright context pool.
 * @param instancePool - The instance registry used for selection and accounting.
 * @param req          - Search request parameters.
 * @returns A fully populated {@link SearchResponse}.
 */
export async function search(
  browserPool: BrowserPool,
  instancePool: InstancePool,
  req: SearchRequest
): Promise<SearchResponse> {
  const startTime = Date.now();
  const concurrency = Math.min(req.parallelAttempts ?? 5, 6);
  const maxRounds = Math.min(Math.max(req.maxRounds ?? 3, 1), 5);
  const errors: string[] = [];
  const triedUrls = new Set<string>();
  let zeroResultRounds = 0;

  const cancelToken = makeCancelToken();
  const roundPromises: Promise<void>[] = [];
  let winner: InstanceSearchResult | null = null;
  const candidates: InstanceSearchResult[] = [];

  // Decision window: wait X ms after first result to see if better ones arrive.
  const DECISION_WINDOW_MS = Number(process.env.SEARCH_DECISION_WINDOW_MS ?? "500");
  let windowStartedAt: number | null = null;

  // How long to wait for a round to produce any result before speculatively
  // starting the next round. 5s balances giving round-1 a real window against
  // wasting time when all round-1 instances are slow: with a 12s navigation
  // timeout, a 7s stagger meant two empty stagger cycles (14s) before the
  // first result — pushing worst-case latency to 22s. At 5s the worst case
  // drops to ~15s while still covering the typical 4-6s instance response time.
  const STAGGER_MS = Number(process.env.SEARCH_STAGGER_MS ?? "5000");

  const orchestration: string[] = [];
  function logDebug(msg: string) {
    orchestration.push(msg);
  }

  for (let round = 0; round < maxRounds; round++) {
    const instances = instancePool.pickN(concurrency, triedUrls);

    if (instances.length === 0) {
      logDebug(`[round-${round + 1}] No more available instances to try.`);
      break;
    }
    
    logDebug(`[round-${round + 1}] Starting with ${instances.length} instances: ${instances.map(i => i.url).join(', ')}`);
    for (const inst of instances) triedUrls.add(inst.url);

    const roundTask = (async () => {
      await Promise.allSettled(
        instances.map(async (inst, idx) => {
          // Stagger instance launches within a round so connections don't all
          // hit different servers at the exact same millisecond — avoids a
          // synchronized burst that looks like coordinated bot traffic.
          if (idx > 0) {
            await new Promise((r) => setTimeout(r, Math.round(Math.random() * 250)));
          }
          if (cancelToken.cancelled) return;
          try {
            const result = await searchOneInstance(
              browserPool,
              inst.url,
              req,
              cancelToken
            );

            if (cancelToken.cancelled) return;

            // Calculate quality score and record it immediately for instance health.
            const quality = resultFilter.calculateQuality(result.results, req.query, req.categories);
            instancePool.recordSuccess(result.instanceUrl, result.latencyMs, quality);

            if (result.results.length > 0) {
              candidates.push(result);
              // Start the decision window timer on the first successful result.
              if (windowStartedAt === null) {
                windowStartedAt = Date.now();
                logDebug(`[window] First result from ${result.instanceUrl} (${result.results.length} results). Starting ${DECISION_WINDOW_MS}ms race.`);
              }
            } else if (!winner || (winner.results.length === 0)) {
               // Fallback winner if no rounds ever find results.
               winner = result;
            }
          } catch (e) {
            if (cancelToken.cancelled) return;
            const errorMsg = String((e as Error)?.message ?? e);
            instancePool.recordFailure(inst.url);
            errors.push(`[${inst.url}] ${errorMsg}`);
          }
        })
      );
    })();

    roundPromises.push(roundTask);

    // Race the current round's completion or the decision window.
    // ±15% jitter makes each round's stagger unique so the timing pattern
    // is not fingerprint-able as a fixed-interval polling loop.
    const staggerJittered = Math.round(STAGGER_MS * (0.85 + Math.random() * 0.3));
    const staggerTimer = new Promise((resolve) => setTimeout(resolve, staggerJittered));
    
    // If a window is open, we race against the widow instead of the round/stagger.
    if (windowStartedAt !== null) {
      const remainingWindow = Math.max(0, DECISION_WINDOW_MS - (Date.now() - windowStartedAt));
      await new Promise(r => setTimeout(r, remainingWindow));
      logDebug(`[window] Decision window closed. Collected ${candidates.length} candidates.`);
      
      const best = resultFilter.pickBest(candidates, req.query, req.categories);
      if (best) {
         winner = best;
         break;
      } else {
         logDebug(`[window] All candidates failed Semantic Floor. Resuming search...`);
         candidates.length = 0;
         windowStartedAt = null;
         winner = null;
      }
    } else {
      const winnerOfRace = await Promise.race([
        roundTask.then(() => "task"),
        staggerTimer.then(() => "stagger"),
      ]);

      if (winnerOfRace === "stagger") {
        logDebug(`[stagger] Round ${round + 1} exceeded ${staggerJittered}ms. Calling reinforcements...`);
      }

      if (candidates.length > 0) {
         const remainingWindow = Math.max(0, DECISION_WINDOW_MS - (Date.now() - (windowStartedAt ?? Date.now())));
         await new Promise((r) => setTimeout(r, remainingWindow));
         logDebug(`[window] Decision window closed after late results. Collected ${candidates.length} candidates.`);

         const best = resultFilter.pickBest(candidates, req.query, req.categories);
         if (best) {
            winner = best;
            break;
         } else {
            logDebug(`[window] All candidates failed Semantic Floor. Resuming search...`);
            candidates.length = 0;
            windowStartedAt = null;
            winner = null;
         }
      }
    }

    // Zero-result budget logic
    if (candidates.length === 0 && winner && (winner as InstanceSearchResult).results.length === 0) {
      zeroResultRounds++;
      if (zeroResultRounds >= MAX_ZERO_ROUNDS) break;
    }
  }

  // Cancel remaining requests now that the window is over.
  cancelToken.cancel();
  Promise.allSettled(roundPromises); 

  // Final summary for debug response
  const debugCandidates = candidates.map((c) => {
    const q = resultFilter.calculateQuality(c.results, req.query, req.categories);
    const s = resultFilter.calculateSemanticScore(c.results, req.query);
    const b = Math.min(0.15, c.results.length * 0.015);
    return {
      instanceUrl: c.instanceUrl,
      qualityScore: q,
      semanticScore: s,
      totalScore: (q * 0.4) + (s * 0.6) + b,
      resultCount: c.results.length,
      isWinner: winner ? c.instanceUrl === winner.instanceUrl : false,
      rejectedReason: s < 0.4 ? 'Semantic Floor' : undefined,
      resultSamples: c.results.slice(0, 3).map(r => r.title),
      allResults: c.results
    };
  });

  if (winner) {
    const w: InstanceSearchResult = winner;
    const maxResults = req.maxResults ?? 10;
    const fullResults = w.results.slice(0, maxResults);

    // Apply the safety filter with category so per-category rules are enforced.
    const { filtered, denied } = resultFilter.apply(fullResults, req.query, req.categories);

    return {
      query: req.query,
      results: fullResults,
      total: fullResults.length,
      filteredResults: filtered,
      deniedResults: denied,
      totalFiltered: filtered.length,
      totalDenied: denied.length,
      pageno: w.pagination.pageno,
      hasPrevPage: w.pagination.hasPrevPage,
      hasNextPage: w.pagination.hasNextPage,
      totalPages: w.pagination.totalPages,
      estimatedResults: w.pagination.estimatedResults,
      instanceUsed: w.instanceUrl,
      elapsedMs: Date.now() - startTime,
      errors,
      answers: w.extras.answers.length > 0 ? w.extras.answers : undefined,
      infobox: w.extras.infobox ?? undefined,
      suggestions:
        w.extras.suggestions.length > 0 ? w.extras.suggestions : undefined,
      debug: {
        candidates: debugCandidates,
        orchestration
      }
    };
  }

  // All rounds exhausted with no winner (or zero-result budget spent).
  return {
    query: req.query,
    results: [],
    total: 0,
    filteredResults: [],
    deniedResults: [],
    totalFiltered: 0,
    totalDenied: 0,
    pageno: req.pageno ?? 1,
    hasPrevPage: false,
    hasNextPage: false,
    totalPages: null,
    estimatedResults: null,
    instanceUsed: "none",
    elapsedMs: Date.now() - startTime,
    errors,
    debug: { candidates: debugCandidates, orchestration },
  };
}

/**
 * Executes multiple search requests concurrently, capping the number of
 * searches running at the same time to the browser context pool size.
 *
 * Without this cap a 20-item batch would immediately try to acquire all 20
 * contexts, starving every other in-flight request. By limiting concurrency
 * to MAX_CONTEXTS, later batch items queue inside this function rather than
 * piling up inside generic-pool.
 *
 * @param browserPool  - The shared Playwright context pool.
 * @param instancePool - The instance registry.
 * @param requests     - Array of up to 20 search requests.
 * @returns Array of {@link SearchResponse} objects in the same order as `requests`.
 */
export async function searchBatch(
  browserPool: BrowserPool,
  instancePool: InstancePool,
  requests: SearchRequest[]
): Promise<SearchResponse[]> {
  const maxConcurrent = Number(process.env.MAX_CONTEXTS ?? "8");

  // Simple counting semaphore: resolve `acquire` only when a slot is free,
  // then call `release` when done to unblock the next waiter.
  let running = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (running < maxConcurrent) {
        running++;
        resolve();
      } else {
        queue.push(() => { running++; resolve(); });
      }
    });
  }

  function release(): void {
    running--;
    const next = queue.shift();
    if (next) next();
  }

  const results = new Array<SearchResponse>(requests.length);

  await Promise.all(
    requests.map(async (req, i) => {
      await acquire();
      try {
        results[i] = await search(browserPool, instancePool, req);
      } finally {
        release();
      }
    })
  );

  return results;
}
