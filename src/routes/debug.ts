/**
 * @file routes/debug.ts
 * Diagnostic endpoints for inspecting what the HTML parser sees.
 *
 * Routes:
 *   POST /debug/parse — feed raw HTML, get back a full parser diagnostic report.
 *   POST /debug/fetch — fetch a URL via the browser pool and return diagnostics.
 *
 * Only registered when NODE_ENV !== "production" to prevent accidentally
 * exposing large HTML payloads in a live deployment.
 */

import * as cheerio from "cheerio";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BrowserPool } from "../browser/pool.js";
import type { Page } from "playwright";
import { parseResults, parseExtras, parsePagination, detectBlock } from "../search/parser.js";

// ─── Route plugin ─────────────────────────────────────────────────────────────

/**
 * Registers `POST /debug/parse` on the given Fastify instance.
 *
 * Accepts raw SearXNG HTML and returns a diagnostic breakdown:
 * - Block detection result
 * - Raw element counts for every candidate result selector
 * - List of CSS classes on each `<article>` element
 * - Snippet of the `#results` container for a quick eyeball check
 * - Full output of `parseResults`, `parseExtras`, and `parsePagination`
 *
 * Use this to investigate why a specific instance's page yields zero results.
 *
 * @param fastify - The Fastify server instance.
 */
export async function debugRoutes(
  fastify: FastifyInstance,
  opts: { browserPool: BrowserPool }
): Promise<void> {
  const { browserPool } = opts;
  const BodySchema = z.object({
    /** Raw HTML string of a SearXNG results page. */
    html: z.string().min(1).max(5_000_000),
    /**
     * HTTP status code to include in block detection.
     * Defaults to 200.
     */
    statusCode: z.number().int().min(100).max(599).optional().default(200),
  });

  fastify.post("/debug/parse", async (request, reply) => {
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { html, statusCode } = parsed.data;
    const $ = cheerio.load(html);

    // ── Selector counts ──────────────────────────────────────────────────────
    // Check multiple candidate selectors so we can detect if the instance uses
    // a different markup version.
    const selectorCounts: Record<string, number> = {
      "article.result":         $("article.result").length,
      "div.result":             $("div.result").length,
      "article.result-default": $("article.result-default").length,
      "article.result-images":  $("article.result-images").length,
      "article.result-videos":  $("article.result-videos").length,
      "article.category-news":  $("article.category-news").length,
      "#results":               $("#results").length,
      "#main_results":          $("#main_results").length,
      ".results":               $(".results").length,
    };

    // ── Article class audit ──────────────────────────────────────────────────
    // Collect the full class attribute of every <article> on the page so we can
    // spot unexpected class names or missing standard ones.
    const articleClasses: string[] = [];
    $("article").each((_, el) => {
      const cls = $(el).attr("class") ?? "(no class)";
      articleClasses.push(cls);
    });

    // ── #results snippet ─────────────────────────────────────────────────────
    // First 2000 chars of the #results container's outer HTML — enough to
    // identify the structure without dumping the entire page.
    const resultsSnippet = ($("#results").html() ?? "").slice(0, 2000) || null;

    // ── <title> and <h1> ────────────────────────────────────────────────────
    const pageTitle = $("title").text().trim();
    const h1Text = $("h1").first().text().trim();

    // ── Block detection ──────────────────────────────────────────────────────
    const blockReason = detectBlock(html, statusCode);

    // ── Full parser output ───────────────────────────────────────────────────
    const results     = parseResults(html);
    const extras      = parseExtras(html);
    const pagination  = parsePagination(html);

    return reply.send({
      // High-level verdict
      blockReason,
      parsedResultCount: results.length,

      // Structural diagnostics
      pageTitle,
      h1Text,
      selectorCounts,
      articleClasses,
      resultsSnippet,

      // Full parser output
      results,
      extras,
      pagination,
    });
  });

  // ── POST /debug/fetch ──────────────────────────────────────────────────────

  const FetchSchema = z.object({
    /**
     * Full SearXNG search URL to fetch via the browser pool.
     * Example: "https://search.unredacted.org/search?q=python&category_general=1"
     */
    url: z.string().url(),
    /** Navigation timeout in milliseconds. Defaults to 15000. */
    timeoutMs: z.number().int().min(1000).max(60000).optional().default(15_000),
  });

  /**
   * Fetches a SearXNG search URL through the real Playwright browser pool
   * and returns the same diagnostic report as `/debug/parse`.
   *
   * This is the primary tool for investigating why a specific instance returns
   * zero results — it shows the real HTML the browser receives, not a curl dump.
   */
  fastify.post("/debug/fetch", async (request, reply) => {
    const parsed = FetchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    if (!browserPool.isReady) {
      return reply.status(503).send({ error: "Browser pool not ready" });
    }

    const { url, timeoutMs } = parsed.data;
    // Origin is the instance base URL — used as the pool key.
    const origin = new URL(url).origin;

    let fetchedHtml = "";
    let fetchedStatus = 200;
    let fetchError: string | null = null;

    try {
      await browserPool.withPage(origin, async (page: Page) => {
        let lastStatus = 200;
        let rawBodyPromise: Promise<Buffer | null> | null = null;

        page.on("response", (resp) => {
          if (resp.url() === url) {
            lastStatus = resp.status();
            rawBodyPromise = resp.body().catch(() => null);
          }
        });

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        fetchedStatus = lastStatus;

        // Wait briefly for JS-rendered results.
        await page.waitForSelector("article.result", { timeout: 5_000 }).catch(() => {});

        const rawBody: Buffer | null =
          rawBodyPromise !== null
            ? await (rawBodyPromise as Promise<Buffer | null>)
            : null;
        fetchedHtml = rawBody ? rawBody.toString("utf-8") : await page.content();
      });
    } catch (err) {
      fetchError = String((err as Error)?.message ?? err);
    }

    if (fetchError) {
      return reply.status(502).send({ error: fetchError, url });
    }

    // Run the same diagnostic as /debug/parse on the fetched HTML.
    const $ = cheerio.load(fetchedHtml);

    const selectorCounts: Record<string, number> = {
      "article.result":         $("article.result").length,
      "div.result":             $("div.result").length,
      "article.result-default": $("article.result-default").length,
      "article.result-images":  $("article.result-images").length,
      "article.result-videos":  $("article.result-videos").length,
      "article.category-news":  $("article.category-news").length,
      "#results":               $("#results").length,
      "#main_results":          $("#main_results").length,
      ".results":               $(".results").length,
    };

    const articleClasses: string[] = [];
    $("article").each((_, el) => {
      const cls = $(el).attr("class") ?? "(no class)";
      articleClasses.push(cls);
    });

    const resultsSnippet = ($("#results").html() ?? "").slice(0, 2000) || null;
    const pageTitle = $("title").text().trim();
    const h1Text = $("h1").first().text().trim();
    const blockReason = detectBlock(fetchedHtml, fetchedStatus);

    const results    = parseResults(fetchedHtml);
    const extras     = parseExtras(fetchedHtml);
    const pagination = parsePagination(fetchedHtml);

    return reply.send({
      fetchedUrl: url,
      httpStatus: fetchedStatus,

      // High-level verdict
      blockReason,
      parsedResultCount: results.length,

      // Structural diagnostics
      pageTitle,
      h1Text,
      selectorCounts,
      articleClasses,
      resultsSnippet,

      // Full parser output
      results,
      extras,
      pagination,
    });
  });
}
