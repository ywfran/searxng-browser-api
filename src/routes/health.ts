/**
 * @file routes/health.ts
 * Fastify plugin that registers operational endpoints.
 *
 * Routes:
 *   GET  /health            — liveness / readiness check
 *   GET  /instances         — per-instance health metrics and circuit-breaker state
 *   POST /pool/restart      — hot-restart the Chromium process
 *   POST /instances/refresh — manually trigger an instance list refresh from searx.space
 */

import type { FastifyInstance } from "fastify";
import type { BrowserPool } from "../browser/pool.js";
import type { InstancePool } from "../instances.js";
import { runRefresh, REFRESH_INTERVAL_HOURS } from "../instance-scheduler.js";
import { loadSavedInstances } from "../instance-fetcher.js";

const startedAt = Date.now();

/**
 * Registers health and operational routes on the given Fastify instance.
 *
 * @param fastify            - The Fastify server instance.
 * @param opts.browserPool   - Initialised browser context pool.
 * @param opts.instancePool  - SearXNG instance registry.
 */
export async function healthRoutes(
  fastify: FastifyInstance,
  opts: { browserPool: BrowserPool; instancePool: InstancePool }
): Promise<void> {
  const { browserPool, instancePool } = opts;

  fastify.get("/health", async (_req, reply) => {
    const saved = await loadSavedInstances();

    return reply.send({
      status: instancePool.available > 0 ? "ok" : "degraded",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      pool: {
        total: instancePool.total,
        available: instancePool.available,
        contexts: browserPool.activeContexts,
        contextsBusy: browserPool.poolBorrowed,
        contextCapacity: browserPool.poolSize,
      },
      instanceList: {
        updatedAt: saved?.updatedAt ?? null,
        refreshIntervalHours: REFRESH_INTERVAL_HOURS,
      },
    });
  });

  fastify.get("/instances", async (_req, reply) => {
    const saved = await loadSavedInstances();

    return reply.send({
      total: instancePool.total,
      available: instancePool.available,
      updatedAt: saved?.updatedAt ?? null,
      instances: instancePool.stats(),
    });
  });

  /**
   * Restarts the Chromium process and rebuilds the context pool.
   * Use this to recover from crashes or uncontrolled memory growth without
   * restarting the Node.js process.
   */
  fastify.post("/pool/restart", async (_req, reply) => {
    fastify.log.warn("Restarting browser pool...");
    await browserPool.restart();
    fastify.log.info("Browser pool restarted successfully");
    return reply.send({ status: "browser pool restarted" });
  });

  /**
   * Manually triggers a fresh instance list fetch from searx.space.
   * Runs synchronously with respect to this request — the response is sent
   * only after the refresh completes (or fails).
   *
   * Ongoing search requests are unaffected: they continue using the current
   * list while the fetch runs, then see the updated list immediately after.
   */
  fastify.post("/instances/refresh", async (_req, reply) => {
    fastify.log.info("Manual instance refresh triggered");
    const count = await runRefresh(instancePool, opts.browserPool, fastify.log);

    if (count === 0) {
      return reply.status(503).send({
        status: "error",
        message: "Refresh failed or returned 0 instances — current list retained",
      });
    }

    return reply.send({
      status: "ok",
      instancesLoaded: count,
    });
  });
}
