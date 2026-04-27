/**
 * @file server.ts
 * Fastify server factory.
 *
 * Configures CORS, rate limiting, registers all route plugins, and wires up
 * graceful shutdown handlers for SIGTERM / SIGINT.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { BrowserPool } from "./browser/pool.js";
import type { InstancePool } from "./instances.js";
import { saveInstances } from "./instance-fetcher.js";
import { searchRoutes } from "./routes/search.js";
import { healthRoutes } from "./routes/health.js";
import { debugRoutes } from "./routes/debug.js";

/**
 * Builds and configures a Fastify application instance.
 *
 * The function does **not** call `listen()` — that is the caller's responsibility.
 * This separation makes the server trivially testable (bind to a random port, etc.).
 *
 * @param browserPool  - Initialised Playwright context pool.
 * @param instancePool - SearXNG instance registry.
 * @returns Configured Fastify instance ready to be started.
 */
export async function createServer(
  browserPool: BrowserPool,
  instancePool: InstancePool
) {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Pretty-print in development; use structured JSON in production.
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
    // Extended keep-alive / connection timeouts for clients like n8n that hold
    // persistent connections across many sequential requests.
    keepAliveTimeout: 75_000,
    connectionTimeout: 90_000,
  });

  // ── Plugins ────────────────────────────────────────────────────────────────

  await fastify.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  // Rate limit protects the browser pool from being overwhelmed by a single
  // client. Adjust MAX_CONTEXTS and this limit together when scaling.
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      error: "Rate limit exceeded",
      retryIn: Math.ceil(context.ttl / 1000),
    }),
  });

  // ── Routes ─────────────────────────────────────────────────────────────────

  await fastify.register(searchRoutes, { browserPool, instancePool });
  await fastify.register(healthRoutes, { browserPool, instancePool });

  if (process.env.NODE_ENV !== "production") {
    await fastify.register(debugRoutes, { browserPool });
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, "Shutting down gracefully...");
    await fastify.close();
    await browserPool.close();
    await saveInstances(instancePool.urls, instancePool.serializeStats()).catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return fastify;
}
