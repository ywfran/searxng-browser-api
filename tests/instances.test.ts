import { describe, it, expect, vi } from "vitest";
import { InstancePool } from "../src/instances.js";

// ─── Score formula helpers ────────────────────────────────────────────────────
// Mirror the constants and formula from instances.ts so tests break if they drift.

const EMA_ALPHA = 0.1;
const DEFAULT_SUCCESS_RATE = 0.5;
const DEFAULT_LATENCY_MS = 3_000;

function latencyScore(emaLatencyMs: number): number {
  const raw = Math.max(0, 1 - (emaLatencyMs - 300) / 5700);
  return Math.pow(raw, 1.5);
}

function compositeScore(emaSuccessRate: number, emaLatencyMs: number): number {
  return emaSuccessRate * 0.65 + latencyScore(emaLatencyMs) * 0.35;
}

// ─── Score formula ────────────────────────────────────────────────────────────

describe("InstancePool — score formula", () => {
  it("fresh instance scores approximately 0.46 with default EMA values", () => {
    const pool = new InstancePool(["https://a.example"]);
    const expected = compositeScore(DEFAULT_SUCCESS_RATE, DEFAULT_LATENCY_MS);
    expect(pool.stats()[0].score).toBeCloseTo(expected, 3);
  });

  it("score improves after a fast successful request", () => {
    const pool = new InstancePool(["https://a.example"]);
    const before = pool.stats()[0].score;
    pool.recordSuccess("https://a.example", 200);
    expect(pool.stats()[0].score).toBeGreaterThan(before);
  });

  it("score degrades after a failure", () => {
    const pool = new InstancePool(["https://a.example"]);
    const before = pool.stats()[0].score;
    pool.recordFailure("https://a.example");
    expect(pool.stats()[0].score).toBeLessThan(before);
  });

  it("score approaches 1.0 after many fast successful requests", () => {
    const pool = new InstancePool(["https://a.example"]);
    for (let i = 0; i < 100; i++) pool.recordSuccess("https://a.example", 100);
    expect(pool.stats()[0].score).toBeGreaterThan(0.9);
  });

  it("score approaches its minimum after many consecutive failures", () => {
    // Failures only update emaSuccessRate → 0; emaLatencyMs is untouched.
    // Minimum achievable: 0 × 0.65 + latencyScore(3000) × 0.35 ≈ 0.134.
    const pool = new InstancePool(["https://a.example"]);
    for (let i = 0; i < 50; i++) pool.recordFailure("https://a.example");
    expect(pool.stats()[0].score).toBeLessThan(0.2);
  });

  it("quality < 1.0 penalises success rate proportionally", () => {
    const pool = new InstancePool(["https://a.example"]);
    const before = pool.stats()[0].score;
    pool.recordSuccess("https://a.example", 200, 0.0); // zero-quality result
    // 0.0 quality acts like a failure on the success rate EMA
    expect(pool.stats()[0].score).toBeLessThan(before);
  });
});

// ─── Circuit breaker ──────────────────────────────────────────────────────────

describe("InstancePool — circuit breaker", () => {
  it("suspends an instance immediately after the first failure", () => {
    const pool = new InstancePool(["https://a.example"]);
    pool.recordFailure("https://a.example");
    expect(pool.stats()[0].available).toBe(false);
    expect(pool.available).toBe(0);
  });

  it("instance becomes available again after suspension window elapses", () => {
    vi.useFakeTimers();
    const pool = new InstancePool(["https://a.example"]);
    pool.recordFailure("https://a.example"); // 1-minute back-off (2^0)
    expect(pool.available).toBe(0);
    vi.advanceTimersByTime(61_000);
    expect(pool.available).toBe(1);
    vi.useRealTimers();
  });

  it("suspension doubles with each consecutive failure (exponential back-off)", () => {
    vi.useFakeTimers();
    const pool = new InstancePool(["https://a.example"]);
    pool.recordFailure("https://a.example"); // 2^0 = 1 min
    pool.recordFailure("https://a.example"); // 2^1 = 2 min

    // 61 seconds covers the first back-off but not the second.
    vi.advanceTimersByTime(61_000);
    expect(pool.available).toBe(0);

    vi.advanceTimersByTime(60_000); // total 121s > 2 min
    expect(pool.available).toBe(1);
    vi.useRealTimers();
  });

  it("caps suspension at 64 minutes regardless of consecutive failures", () => {
    vi.useFakeTimers();
    const pool = new InstancePool(["https://a.example"]);
    for (let i = 0; i < 20; i++) pool.recordFailure("https://a.example");
    vi.advanceTimersByTime(64 * 60_000 + 1_000);
    expect(pool.available).toBe(1);
    vi.useRealTimers();
  });

  it("resets consecutive failures counter on success (next failure starts back-off from 1 min)", () => {
    vi.useFakeTimers();
    const pool = new InstancePool(["https://a.example"]);
    pool.recordFailure("https://a.example"); // 1 min
    pool.recordFailure("https://a.example"); // 2 min

    vi.advanceTimersByTime(130_000); // past 2-min suspension
    pool.recordSuccess("https://a.example", 500); // resets counter

    pool.recordFailure("https://a.example"); // back to 1 min (2^0)
    vi.advanceTimersByTime(61_000);
    expect(pool.available).toBe(1);
    vi.useRealTimers();
  });

  it("suspendedUntil is present in stats when instance is suspended", () => {
    const pool = new InstancePool(["https://a.example"]);
    pool.recordFailure("https://a.example");
    const stat = pool.stats()[0];
    expect(stat.suspendedUntil).toBeDefined();
    expect(new Date(stat.suspendedUntil!).getTime()).toBeGreaterThan(Date.now());
  });
});

// ─── pickN ────────────────────────────────────────────────────────────────────

describe("InstancePool — pickN", () => {
  it("returns at most N instances", () => {
    const pool = new InstancePool([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
    expect(pool.pickN(2)).toHaveLength(2);
  });

  it("returns all instances when N exceeds pool size", () => {
    const pool = new InstancePool(["https://a.example", "https://b.example"]);
    expect(pool.pickN(10)).toHaveLength(2);
  });

  it("excludes specified URLs", () => {
    const pool = new InstancePool([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
    const picked = pool.pickN(3, new Set(["https://a.example"]));
    expect(picked.map((i) => i.url)).not.toContain("https://a.example");
  });

  it("falls back to suspended instances when all are suspended (prevents stall)", () => {
    vi.useFakeTimers();
    const pool = new InstancePool(["https://a.example", "https://b.example"]);
    pool.recordFailure("https://a.example");
    pool.recordFailure("https://b.example");
    expect(pool.available).toBe(0);
    expect(pool.pickN(2).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("returns empty array when all instances are in the exclude set", () => {
    const pool = new InstancePool(["https://a.example"]);
    expect(pool.pickN(3, new Set(["https://a.example"]))).toHaveLength(0);
  });

  it("prefers higher-scoring instances", () => {
    const pool = new InstancePool(["https://slow.example", "https://fast.example"]);
    for (let i = 0; i < 50; i++) pool.recordSuccess("https://fast.example", 100);
    for (let i = 0; i < 50; i++) pool.recordSuccess("https://slow.example", 6000);

    // Run pickN many times and confirm fast instance dominates first-pick selections.
    let fastFirst = 0;
    for (let i = 0; i < 20; i++) {
      if (pool.pickN(1)[0]?.url === "https://fast.example") fastFirst++;
    }
    expect(fastFirst).toBeGreaterThan(10);
  });
});

// ─── Serialize / restore ─────────────────────────────────────────────────────

describe("InstancePool — serializeStats / updateInstances restore", () => {
  it("serialised stats include success/failure counters and EMA values", () => {
    const pool = new InstancePool(["https://a.example"]);
    pool.recordSuccess("https://a.example", 400);
    pool.recordSuccess("https://a.example", 600);
    pool.recordFailure("https://a.example");

    const stats = pool.serializeStats();
    expect(stats["https://a.example"].successCount).toBe(2);
    expect(stats["https://a.example"].failureCount).toBe(1);
    expect(stats["https://a.example"].emaSuccessRate).toBeGreaterThan(0);
    expect(stats["https://a.example"].emaLatencyMs).toBeGreaterThan(0);
  });

  it("updateInstances restores EMA so a new pool starts warm", () => {
    const pool = new InstancePool(["https://a.example"]);
    for (let i = 0; i < 50; i++) pool.recordSuccess("https://a.example", 100);
    const serialized = pool.serializeStats();

    // updateInstances only restores stats for instances not already in the pool.
    // Start from an empty pool so the instance is treated as new on restore.
    const freshPool = new InstancePool([]);
    freshPool.updateInstances(["https://a.example"], serialized);

    const coldScore = compositeScore(DEFAULT_SUCCESS_RATE, DEFAULT_LATENCY_MS);
    expect(freshPool.stats()[0].score).toBeGreaterThan(coldScore);
  });

  it("circuit-breaker state is not persisted (transient state cleared on restore)", () => {
    const pool = new InstancePool(["https://a.example"]);
    pool.recordFailure("https://a.example");
    expect(pool.available).toBe(0);

    const serialized = pool.serializeStats();
    const freshPool = new InstancePool(["https://a.example"]);
    freshPool.updateInstances(["https://a.example"], serialized);
    // Fresh pool after restore should have no suspension
    expect(freshPool.available).toBe(1);
  });
});

// ─── updateInstances ─────────────────────────────────────────────────────────

describe("InstancePool — updateInstances", () => {
  it("removes instances that are no longer in the new list", () => {
    const pool = new InstancePool(["https://a.example", "https://b.example"]);
    pool.updateInstances(["https://a.example"]);
    expect(pool.total).toBe(1);
    expect(pool.urls).toContain("https://a.example");
    expect(pool.urls).not.toContain("https://b.example");
  });

  it("preserves in-memory EMA stats for instances that remain", () => {
    const pool = new InstancePool(["https://a.example", "https://b.example"]);
    for (let i = 0; i < 10; i++) pool.recordSuccess("https://a.example", 200);
    const scoreBefore = pool.stats().find((s) => s.url === "https://a.example")!.score;

    pool.updateInstances(["https://a.example", "https://c.example"]);
    const scoreAfter = pool.stats().find((s) => s.url === "https://a.example")!.score;
    expect(scoreAfter).toBe(scoreBefore);
  });

  it("adds new instances with neutral default scores", () => {
    const pool = new InstancePool(["https://a.example"]);
    pool.updateInstances(["https://a.example", "https://new.example"]);
    const newStat = pool.stats().find((s) => s.url === "https://new.example");
    expect(newStat).toBeDefined();
    const expected = compositeScore(DEFAULT_SUCCESS_RATE, DEFAULT_LATENCY_MS);
    expect(newStat!.score).toBeCloseTo(expected, 3);
  });

  it("reflects the new total and available counts after update", () => {
    const pool = new InstancePool(["https://a.example", "https://b.example"]);
    pool.updateInstances(["https://c.example", "https://d.example", "https://e.example"]);
    expect(pool.total).toBe(3);
    expect(pool.available).toBe(3);
  });
});
