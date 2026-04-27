/**
 * @file instance-scheduler.ts
 * Manages automatic refresh of the SearXNG instance list on startup and on a
 * configurable repeating interval.
 *
 * Startup sequence:
 *   1. Load the cached list from `data/instances.json` (instant, no network).
 *      If a cached list exists, apply it immediately — the API is ready to
 *      serve requests before the network fetch completes.
 *   2. Fetch a fresh list from searx.space in the background.
 *   3. When the background fetch completes, atomically update the pool and
 *      save the new list to disk.
 *   4. Schedule the next refresh after INSTANCE_REFRESH_INTERVAL_HOURS hours.
 *
 * Configuration (environment variables):
 *   INSTANCE_REFRESH_INTERVAL_HOURS — Hours between refreshes. Default: 6.
 *   INSTANCE_MIN_UPTIME             — Minimum monthly uptime % to include an instance. Default: 80.
 */

import { fetchInstances, saveInstances, loadSavedInstances } from "./instance-fetcher.js";
import type { InstancePool } from "./instances.js";
import type { BrowserPool } from "./browser/pool.js";

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Hours between successive instance-list refreshes.
 * A shorter interval keeps the pool fresher at the cost of more outbound
 * requests to searx.space. 6 hours is a good balance for a public instance list
 * that changes meaningfully only a few times per day.
 * Change via the INSTANCE_REFRESH_INTERVAL_HOURS environment variable.
 */
export const REFRESH_INTERVAL_HOURS = Math.max(
  1,
  Number(process.env.INSTANCE_REFRESH_INTERVAL_HOURS ?? "6")
);

// ─── Logger interface ─────────────────────────────────────────────────────────

/** Minimal logger interface so the scheduler is not coupled to Fastify. */
interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg: string): void;
}

// ─── Scheduling helpers ───────────────────────────────────────────────────────

/**
 * Returns the interval in milliseconds between successive refreshes.
 *
 * @param hours - Desired interval in hours.
 */
function msRefreshInterval(hours: number): number {
  return hours * 60 * 60_000;
}

// ─── Core refresh logic ───────────────────────────────────────────────────────

/**
 * Fetches a fresh instance list from searx.space, updates the instance pool,
 * persists the result to disk, and prunes stale browser cookies.
 *
 * Errors are caught and logged — the pool continues with its current list if
 * the refresh fails. This makes the refresh safe to call at any point.
 *
 * @param instancePool - The live InstancePool to update.
 * @param browserPool  - The BrowserPool whose cookie store should be pruned.
 * @param log          - Logger for progress and error messages.
 * @returns The number of instances loaded, or 0 on failure.
 */
export async function runRefresh(
  instancePool: InstancePool,
  browserPool: BrowserPool,
  log: Logger
): Promise<number> {
  log.info("Refreshing SearXNG instance list from searx.space...");

  try {
    const urls = await fetchInstances();

    if (urls.length === 0) {
      log.warn("searx.space returned 0 usable instances — keeping current list");
      return 0;
    }

    instancePool.updateInstances(urls);
    await saveInstances(urls, instancePool.serializeStats());
    log.info(`Instance list updated: ${urls.length} instances loaded`);

    // Remove cookies for origins that are no longer in the active list.
    const activeOrigins = new Set(urls.map((u) => new URL(u).origin));
    browserPool.pruneOrigins(activeOrigins);

    return urls.length;
  } catch (err) {
    log.error(err, "Failed to refresh instance list — keeping current list");
    return 0;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises the instance list from cache and schedules ongoing refreshes.
 *
 * This function returns as soon as the cached list (if any) is applied.
 * The network fetch happens asynchronously and does not block the caller.
 *
 * @param instancePool - The live InstancePool to manage.
 * @param browserPool  - The BrowserPool whose cookie store should be pruned on refresh.
 * @param log          - Logger for progress and error messages.
 */
export async function startInstanceScheduler(
  instancePool: InstancePool,
  browserPool: BrowserPool,
  log: Logger
): Promise<void> {
  // Step 1: Apply cached list immediately for zero-latency startup.
  // Restore persisted EMA stats so the pool is warm from the first request —
  // previously-learned scores and latencies are available without retraining.
  const cached = await loadSavedInstances();
  if (cached) {
    instancePool.updateInstances(cached.urls, cached.stats);
    const statsInfo = cached.stats
      ? ` (EMA scores restored for ${Object.keys(cached.stats).length} instances)`
      : " (no EMA stats in cache — starting at neutral 0.5)";
    log.info(
      `Loaded ${cached.count} cached instances (last updated ${cached.updatedAt})${statsInfo}`
    );
  } else {
    log.warn("No cached instance list found — using emergency fallback (10 instances) until network fetch completes");
  }

  // Step 2: Background refresh (does not block startup).
  runRefresh(instancePool, browserPool, log).then(() =>
    scheduleNextRefresh(instancePool, browserPool, log)
  );
}

/**
 * Schedules the next refresh using `setTimeout`.
 *
 * The timer is `.unref()`-ed so it does not prevent the Node.js process from
 * exiting if all other work is done (e.g. during tests).
 *
 * @param instancePool - The live InstancePool.
 * @param browserPool  - The BrowserPool whose cookie store should be pruned on refresh.
 * @param log          - Logger.
 */
function scheduleNextRefresh(
  instancePool: InstancePool,
  browserPool: BrowserPool,
  log: Logger
): void {
  const delayMs = msRefreshInterval(REFRESH_INTERVAL_HOURS);
  const nextAt = new Date(Date.now() + delayMs).toISOString();
  log.info(`Next instance refresh in ${REFRESH_INTERVAL_HOURS}h (at ${nextAt})`);

  setTimeout(() => {
    runRefresh(instancePool, browserPool, log).then(() =>
      scheduleNextRefresh(instancePool, browserPool, log)
    );
  }, delayMs).unref();
}
