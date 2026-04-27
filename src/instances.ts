/**
 * @file instances.ts
 * SearXNG instance pool with health tracking and per-instance circuit breaking.
 *
 * Each instance maintains a composite score (success rate + latency) that drives
 * weighted selection. Failing instances are suspended with exponential back-off so
 * healthy instances are preferred without permanently blacklisting slow ones.
 */

import fs from "node:fs";
import path from "node:path";
import type { InstanceStats } from "./types.js";

// ─── Persistence shape ────────────────────────────────────────────────────────

/**
 * EMA state persisted to disk for a single instance.
 * Stored inside `data/instances.json` so scores survive server restarts.
 * Instances removed from the searx.space list are automatically dropped
 * from the file on the next save.
 */
export interface PersistedInstanceStats {
  emaSuccessRate: number;
  emaLatencyMs: number;
  successCount: number;
  failureCount: number;
}

// ─── Emergency fallback instance list ────────────────────────────────────────
// Used ONLY when both the cached list (data/instances.json) and the live fetch
// from searx.space are unavailable. Under normal operation this list is never
// reached — it exists solely to keep the API functional during a cold start with
// no network access.
//
// Do NOT grow this list. It is intentionally small. The authoritative source is
// searx.space; see src/instance-fetcher.ts.

const FALLBACK_INSTANCES: string[] = [
  "https://searx.rhscz.eu",
  "https://searx.tiekoetter.com",
  "https://searxng.site",
  "https://searxng.website",
  "https://opnxng.com",
  "https://searx.oloke.xyz",
  "https://search.abohiccups.com",
  "https://searxng.fishfvch.com",
  "https://priv.au",
  "https://searx.redgarden.cv",
];

// ─── Instance ────────────────────────────────────────────────────────────────

/**
 * Tracks runtime health metrics for a single SearXNG instance.
 * Not exported — all external interaction goes through {@link InstancePool}.
 */
/**
 * Smoothing factor for all EMA calculations.
 * α = 0.1 gives an effective window of ~20 most recent observations,
 * so recent behaviour dominates without being overly noisy.
 */
const EMA_ALPHA = 0.1;

class Instance {
  readonly url: string;

  // ── Display-only counters ─────────────────────────────────────────────────
  // These are never used for scoring — they exist solely for /instances output.
  successCount = 0;
  failureCount = 0;

  // ── EMA-based scoring ─────────────────────────────────────────────────────
  /**
   * Exponential moving average of request outcomes (1 = success, 0 = failure).
   * Starts at 0.5 so new instances receive traffic before real data exists.
   */
  private emaSuccessRate = 0.5;

  /**
   * EMA of round-trip latency in milliseconds for successful requests.
   * Starts at 3000 ms — a neutral mid-range that won't artificially favour
   * or penalise a new instance before any latency data is recorded.
   */
  private emaLatencyMs = 3_000;

  // ── Circuit breaker ───────────────────────────────────────────────────────
  /**
   * Number of consecutive failures since the last success.
   * Drives exponential back-off; resets to 0 on every success.
   * Kept separate from `failureCount` (which is cumulative) so that a
   * partial recovery doesn't reduce the backoff exponent.
   */
  private consecutiveFailures = 0;

  /** Epoch timestamp (ms) until which this instance is suspended, or null. */
  suspendedUntil: number | null = null;

  constructor(url: string) {
    this.url = url;
  }

  /** Whether the instance is currently eligible to receive requests. */
  get available(): boolean {
    return this.suspendedUntil === null || Date.now() >= this.suspendedUntil;
  }

  /** EMA-smoothed latency of successful requests in ms. */
  get avgLatencyMs(): number {
    return Math.round(this.emaLatencyMs);
  }

  /**
   * Composite score in [0, 1] combining EMA success rate (65%) and EMA latency (35%).
   *
   * Using EMA instead of cumulative counters means a recently-broken instance
   * degrades quickly (within ~20 requests) rather than coasting on historic
   * successes for hours. Symmetrically, a recovered instance earns its score
   * back within the same window.
   */
  get score(): number {
    // Latency curve: 1.0 at ≤300 ms, decaying faster after 3000ms.
    // Using a power of 1.5 makes the score drop more sharply for slow instances,
    // so they are quickly deprioritised once their EMA latency climbs.
    const rawLatencyScore = Math.max(0, 1 - (this.emaLatencyMs - 300) / 5700);
    const latencyScore = Math.pow(rawLatencyScore, 1.5);

    return this.emaSuccessRate * 0.65 + latencyScore * 0.35;
  }

  /**
   * Records a successful request and updates both EMA accumulators.
   * @param latencyMs - Round-trip latency of the completed request.
   * @param quality - Score from 0.0 to 1.0 based on result relevance. Default: 1.0.
   */
  recordSuccess(latencyMs: number, quality: number = 1.0): void {
    this.successCount++;
    // Penalise success rate if quality is low. 0% quality acts like a failure.
    this.emaSuccessRate =
      EMA_ALPHA * quality + (1 - EMA_ALPHA) * this.emaSuccessRate;
    this.emaLatencyMs =
      EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * this.emaLatencyMs;
    this.consecutiveFailures = 0;
    this.suspendedUntil = null;
  }

  /**
   * Records a failed request, updates the success-rate EMA, and suspends the
   * instance with exponential back-off based on consecutive failures.
   * Suspension doubles with each streak failure, capped at 64 minutes.
   */
  recordFailure(): void {
    this.failureCount++;
    this.consecutiveFailures++;
    this.emaSuccessRate =
      EMA_ALPHA * 0 + (1 - EMA_ALPHA) * this.emaSuccessRate;
    const backoffMinutes = Math.min(
      Math.pow(2, this.consecutiveFailures - 1),
      64
    );
    this.suspendedUntil = Date.now() + backoffMinutes * 60_000;
  }

  /**
   * Serialises the EMA state for disk persistence.
   * Only the fields needed to reconstruct scoring are included — transient
   * state like `suspendedUntil` and `consecutiveFailures` is intentionally
   * omitted so a restarted server starts with a clean circuit-breaker slate.
   */
  serialize(): PersistedInstanceStats {
    return {
      emaSuccessRate: this.emaSuccessRate,
      emaLatencyMs: this.emaLatencyMs,
      successCount: this.successCount,
      failureCount: this.failureCount,
    };
  }

  /**
   * Restores EMA state from a persisted snapshot.
   * Called when the instance list is loaded from `data/instances.json` at
   * startup so the pool is immediately "warm" with historical scoring data.
   *
   * @param data - Previously serialised stats for this instance URL.
   */
  restore(data: PersistedInstanceStats): void {
    this.emaSuccessRate = data.emaSuccessRate;
    this.emaLatencyMs = data.emaLatencyMs;
    this.successCount = data.successCount;
    this.failureCount = data.failureCount;
  }

  /** Serialises runtime metrics into the public {@link InstanceStats} shape. */
  toStats(): InstanceStats {
    return {
      url: this.url,
      score: Number(this.score.toFixed(3)),
      available: this.available,
      successCount: this.successCount,
      failureCount: this.failureCount,
      avgLatencyMs: this.avgLatencyMs,
      suspendedUntil: this.suspendedUntil
        ? new Date(this.suspendedUntil).toISOString()
        : undefined,
    };
  }
}

// ─── InstancePool ────────────────────────────────────────────────────────────

/**
 * Manages the full collection of SearXNG instances, providing weighted selection
 * and centralised success/failure accounting for the circuit breaker.
 */
export class InstancePool {
  private readonly instances: Map<string, Instance>;

  /**
   * @param urls - Override the default instance list (primarily used in tests).
   */
  constructor(urls: string[] = FALLBACK_INSTANCES) {
    this.instances = new Map(urls.map((url) => [url, new Instance(url)]));
  }

  /**
   * Selects up to N instances ranked by score with a small random jitter to
   * spread load and avoid all requests hammering the same top-ranked instance.
   *
   * If all instances are suspended the method falls back to returning the least-
   * penalised ones so the system never stalls entirely.
   *
   * @param n       - Desired number of instances (clamped to pool size).
   * @param exclude - Optional set of instance URLs to skip (used for retry rounds).
   * @returns Up to N instances sorted by adjusted score, descending.
   */
  pickN(n: number, exclude?: ReadonlySet<string>): Instance[] {
    const candidates = [...this.instances.values()].filter(
      (i) => !exclude?.has(i.url)
    );
    const available = candidates.filter((i) => i.available);
    const pool = available.length > 0 ? available : candidates;

    // If every non-excluded instance is exhausted, return empty.
    if (pool.length === 0) return [];

    return pool
      .map((inst) => ({ inst, key: inst.score + Math.random() * 0.08 }))
      .sort((a, b) => b.key - a.key)
      .slice(0, n)
      .map((x) => x.inst);
  }

  /**
   * Records a successful request for the given instance URL.
   * @param url - Instance base URL.
   * @param latencyMs - Round-trip latency of the request.
   * @param quality - Relevance score for the results (0.0 - 1.0).
   */
  recordSuccess(url: string, latencyMs: number, quality: number = 1.0): void {
    this.instances.get(url)?.recordSuccess(latencyMs, quality);
  }

  /**
   * Records a failed request for the given instance URL, triggering back-off.
   * @param url - Instance base URL.
   */
  recordFailure(url: string): void {
    this.instances.get(url)?.recordFailure();
  }

  /**
   * Atomically replaces the active instance list with a new set of URLs.
   *
   * - URLs present in both the old and new list **keep** their existing in-memory
   *   stats so the circuit breaker is not reset mid-session.
   * - New URLs receive fresh `Instance` objects. If `persistedStats` is provided
   *   and contains an entry for the URL, that EMA state is restored immediately
   *   so the pool starts warm instead of treating all new instances as unknowns.
   * - URLs removed from the new list are discarded from memory. Their stats are
   *   automatically absent from the next `serializeStats()` call, so they also
   *   disappear from `data/instances.json` on the next save.
   *
   * The update is performed in-place on the existing Map, so any code holding
   * a reference to this pool immediately sees the new list without any locking.
   *
   * @param urls           - The replacement list of instance base URLs.
   * @param persistedStats - Optional EMA snapshot loaded from disk (startup only).
   */
  updateInstances(
    urls: string[],
    persistedStats?: Record<string, PersistedInstanceStats>
  ): void {
    // Load blocklist from data/instances_blocklist.json
    let blocklist: string[] = [];
    try {
      const blocklistPath = path.join(process.cwd(), "data", "instances_blocklist.json");
      if (fs.existsSync(blocklistPath)) {
        blocklist = JSON.parse(fs.readFileSync(blocklistPath, "utf-8"));
      }
    } catch {
      // Blocklist unavailable — all URLs remain eligible.
    }

    const filteredUrls = urls.filter(url => !blocklist.includes(url));
    const incoming = new Set(filteredUrls);

    // Remove instances that are no longer in the new list.
    for (const url of this.instances.keys()) {
      if (!incoming.has(url)) this.instances.delete(url);
    }

    // Add new instances; restore persisted EMA state when available.
    for (const url of filteredUrls) {
      if (!this.instances.has(url)) {
        const inst = new Instance(url);
        const saved = persistedStats?.[url];
        if (saved) inst.restore(saved);
        this.instances.set(url, inst);
      }
    }
  }

  /**
   * Returns a serialised snapshot of every instance's EMA state.
   * Pass this to {@link saveInstances} to persist scores across restarts.
   * Only currently-active instances are included — removed ones are implicitly
   * pruned because they are no longer in the Map.
   */
  serializeStats(): Record<string, PersistedInstanceStats> {
    const out: Record<string, PersistedInstanceStats> = {};
    for (const [url, inst] of this.instances) {
      out[url] = inst.serialize();
    }
    return out;
  }

  /**
   * Returns serialised stats for all instances, sorted by score descending.
   * Used by the GET /instances endpoint.
   */
  stats(): InstanceStats[] {
    return [...this.instances.values()]
      .map((i) => i.toStats())
      .sort((a, b) => b.score - a.score);
  }

  /** Total number of tracked instances. */
  get total(): number {
    return this.instances.size;
  }

  /** Returns all currently-active instance base URLs. */
  get urls(): string[] {
    return [...this.instances.keys()];
  }

  /** Number of instances currently available (not suspended). */
  get available(): number {
    return [...this.instances.values()].filter((i) => i.available).length;
  }
}
