/**
 * @file routes/search.ts
 * Fastify plugin that registers the search endpoints.
 *
 * Routes:
 *   POST /search        — single query
 *   POST /search/batch  — up to 20 concurrent queries
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BrowserPool } from "../browser/pool.js";
import type { InstancePool } from "../instances.js";
import { search, searchBatch } from "../search/engine.js";

// ─── Validation schemas ───────────────────────────────────────────────────────

const SearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  language: z.string().optional().default("auto"),
  categories: z.string().optional().default("general"),
  engines: z.array(z.string()).optional(),
  pageno: z.number().int().min(1).max(50).optional().default(1),
  maxResults: z.number().int().min(1).max(50).optional().default(10),
  timeoutMs: z.number().int().min(3000).max(30000).optional(),
  parallelAttempts: z.number().int().min(1).max(6).optional().default(5),
  maxRounds: z.number().int().min(1).max(5).optional(),
  timeRange: z.enum(["day", "week", "month", "year", ""]).optional().default(""),
  safeSearch: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .optional()
    .default(2),
});

const BatchRequestSchema = z.array(SearchRequestSchema).min(1).max(20);

// ─── Route plugin ─────────────────────────────────────────────────────────────

/**
 * Registers POST /search and POST /search/batch on the given Fastify instance.
 *
 * @param fastify      - The Fastify server instance.
 * @param opts.browserPool  - Initialised browser context pool.
 * @param opts.instancePool - SearXNG instance registry.
 */
export async function searchRoutes(
  fastify: FastifyInstance,
  opts: { browserPool: BrowserPool; instancePool: InstancePool }
): Promise<void> {
  const { browserPool, instancePool } = opts;

  fastify.post("/search", async (request, reply) => {
    const parsed = SearchRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    if (!browserPool.isReady) {
      return reply.status(503).send({ error: "Browser pool not ready" });
    }

    return reply.send(await search(browserPool, instancePool, parsed.data));
  });

  fastify.post("/search/batch", async (request, reply) => {
    const parsed = BatchRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        details: parsed.error.flatten(),
      });
    }

    if (!browserPool.isReady) {
      return reply.status(503).send({ error: "Browser pool not ready" });
    }

    return reply.send(
      await searchBatch(browserPool, instancePool, parsed.data)
    );
  });
}
