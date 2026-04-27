/**
 * @file engine.test.ts
 * Unit tests for the search() orchestration in search/engine.ts.
 *
 * Strategy: the BrowserPool mock returns pre-built HTML that parseAll() can
 * parse into real SearchResult objects. Result titles include the query terms
 * so the semantic scorer assigns a score > 0.4 (the semantic floor) and
 * candidates are not rejected by ResultFilter.pickBest().
 *
 * The InstancePool mock controls which instances are returned per pickN() call,
 * letting tests drive round logic deterministically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { search } from "../src/search/engine.js";
import type { BrowserPool } from "../src/browser/pool.js";
import type { InstancePool } from "../src/instances.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

type InstanceBehaviour = "results" | "zero" | "error";

interface MockInstanceDef {
  url: string;
  behaviour: InstanceBehaviour;
  resultCount?: number;
  errorMsg?: string;
}

/**
 * Builds HTML with article titles that contain the query terms so the semantic
 * scorer produces a score well above the 0.4 floor.
 *
 * Articles use `class="result result-default"` so parseResults dispatches them
 * through the general web parser. The `<div id="results">` wrapper satisfies
 * the engine's redirect-detection check (`$("#results")`).
 */
function buildHtml(def: MockInstanceDef, query: string): string {
  const articles =
    def.behaviour === "results"
      ? Array.from({ length: def.resultCount ?? 0 }, (_, i) =>
          `<article class="result result-default">` +
          `<h3><a href="${def.url}/page${i + 1}">${query} — result ${i + 1}</a></h3>` +
          `<p class="content">Detailed information about ${query}.</p>` +
          `</article>`
        ).join("\n")
      : "";
  return `<html><body><div id="results">${articles}</div></body></html>`;
}

/**
 * Creates a minimal BrowserPool mock. `withPage` invokes the callback with a
 * fake Page that navigates cleanly and returns controlled HTML via content().
 */
function mockBrowserPool(
  defs: Map<string, MockInstanceDef>,
  query: string
): BrowserPool {
  return {
    isReady: true,
    withPage: vi.fn(async (instanceUrl: string, fn: (page: never) => Promise<unknown>) => {
      const def = defs.get(instanceUrl);
      if (!def) throw new Error(`Unknown mock instance: ${instanceUrl}`);
      if (def.behaviour === "error") throw new Error(def.errorMsg ?? "mock_error");

      const html = buildHtml(def, query);

      const fakePage = {
        on: vi.fn(),
        goto: vi.fn(() => Promise.resolve({ status: () => 200 })),
        url: vi.fn(() => `${instanceUrl}/search?q=${encodeURIComponent(query)}`),
        content: vi.fn(() => Promise.resolve(html)),
        title: vi.fn(() => Promise.resolve("Search Results")),
        waitForSelector: vi.fn(() => Promise.resolve(null)),
        waitForURL: vi.fn(() => Promise.resolve()),
        route: vi.fn(() => Promise.resolve()),
        context: vi.fn(() => ({
          addCookies: vi.fn(() => Promise.resolve()),
        })),
      } as never;

      return fn(fakePage);
    }),
  } as unknown as BrowserPool;
}

/**
 * Creates a minimal InstancePool mock. pickN returns controlled URL lists per
 * call so tests can drive multi-round logic deterministically.
 *
 * @param pickOrder - One array of URLs per pickN() call. Later calls return [].
 */
function mockInstancePool(
  defs: MockInstanceDef[],
  pickOrder: string[][]
): Partial<InstancePool> {
  let callIndex = 0;
  return {
    pickN: vi.fn((n: number, exclude?: ReadonlySet<string>) => {
      const urls = callIndex < pickOrder.length ? pickOrder[callIndex] : [];
      callIndex++;
      return defs
        .filter((d) => urls.includes(d.url) && !exclude?.has(d.url))
        .map((d) => ({ url: d.url, available: true }))
        .slice(0, n) as never[];
    }),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    total: defs.length,
    available: defs.length,
  };
}

function makeRequest(
  query: string,
  overrides: Record<string, unknown> = {}
): Parameters<typeof search>[2] {
  return {
    query,
    categories: "general",
    maxResults: 10,
    timeoutMs: 5000,
    ...overrides,
  } as never;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const QUERY = "javascript tutorial";

describe("search() — round orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns results from the first instance when it responds with content", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://a.example", behaviour: "results", resultCount: 5 },
      { url: "https://b.example", behaviour: "results", resultCount: 3 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [["https://a.example", "https://b.example"]]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 2 })
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
    expect(result.instanceUsed).toMatch(/a\.example|b\.example/);
    expect(result.errors).toHaveLength(0);
  });

  it("skips an instance that returns zero results and uses one that has content", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://zero.example", behaviour: "zero" },
      { url: "https://good.example", behaviour: "results", resultCount: 4 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [
      ["https://zero.example", "https://good.example"],
    ]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 2 })
    );

    expect(result.total).toBe(4);
    expect(result.instanceUsed).toBe("https://good.example");
  });

  it("launches a second round when the first round returns all zeros", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://r1.example", behaviour: "zero" },
      { url: "https://r2.example", behaviour: "results", resultCount: 3 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [
      ["https://r1.example"],
      ["https://r2.example"],
    ]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 1, maxRounds: 3 })
    );

    expect(result.total).toBe(3);
    expect(result.instanceUsed).toBe("https://r2.example");
  });

  it("returns empty results after MAX_ZERO_ROUNDS consecutive zero-result rounds", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://z1.example", behaviour: "zero" },
      { url: "https://z2.example", behaviour: "zero" },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [
      ["https://z1.example"],
      ["https://z2.example"],
    ]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 1, maxRounds: 5 })
    );

    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it("records failures for erroring instances and surfaces them in errors[]", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://err.example", behaviour: "error", errorMsg: "timeout" },
      { url: "https://ok.example", behaviour: "results", resultCount: 2 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [
      ["https://err.example", "https://ok.example"],
    ]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 2 })
    );

    expect(result.total).toBe(2);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("err.example");
    expect((instancePool.recordFailure as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => c[0] === "https://err.example"
    )).toBe(true);
  });

  it("respects maxResults by slicing the winner's result list", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://big.example", behaviour: "results", resultCount: 10 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [["https://big.example"]]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { maxResults: 3, parallelAttempts: 1 })
    );

    expect(result.total).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  it("includes the debug object with candidates and orchestration log", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://a.example", behaviour: "results", resultCount: 5 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [["https://a.example"]]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { debug: true, parallelAttempts: 1 })
    );

    expect(result.debug).toBeDefined();
    expect(Array.isArray(result.debug!.candidates)).toBe(true);
    expect(Array.isArray(result.debug!.orchestration)).toBe(true);
    expect(result.debug!.orchestration.length).toBeGreaterThan(0);
  });

  it("includes the debug object even when all rounds return zero results", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://z.example", behaviour: "zero" },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [["https://z.example"], []]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 1, maxRounds: 2 })
    );

    expect(result.total).toBe(0);
    expect(result.debug).toBeDefined();
    expect(result.debug!.orchestration).toBeDefined();
  });

  it("populates filteredResults and deniedResults from the winner's results", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://a.example", behaviour: "results", resultCount: 5 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [["https://a.example"]]);

    const result = await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 1 })
    );

    // filteredResults + deniedResults = total results
    expect(result.filteredResults.length + result.deniedResults.length).toBe(result.total);
    expect(result.totalFiltered + result.totalDenied).toBe(result.total);
  });

  it("records success with quality score on each successful instance", async () => {
    const defs: MockInstanceDef[] = [
      { url: "https://a.example", behaviour: "results", resultCount: 5 },
    ];
    const browserPool = mockBrowserPool(new Map(defs.map((d) => [d.url, d])), QUERY);
    const instancePool = mockInstancePool(defs, [["https://a.example"]]);

    await search(
      browserPool as BrowserPool,
      instancePool as InstancePool,
      makeRequest(QUERY, { parallelAttempts: 1 })
    );

    const successCalls = (instancePool.recordSuccess as ReturnType<typeof vi.fn>).mock.calls;
    expect(successCalls.length).toBeGreaterThan(0);
    expect(successCalls[0][0]).toBe("https://a.example");
    // Third argument is the quality score (0–1)
    expect(successCalls[0][2]).toBeGreaterThan(0);
    expect(successCalls[0][2]).toBeLessThanOrEqual(1);
  });
});
