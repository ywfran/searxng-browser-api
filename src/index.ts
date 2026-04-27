/**
 * @file index.ts
 * Application entrypoint.
 *
 * Initialisation order:
 *   1. InstancePool  — loads the built-in fallback instance list (synchronous).
 *   2. BrowserPool   — launches Chromium and warms the context pool.
 *   3. HTTP server   — starts Fastify and begins accepting requests.
 *   4. Scheduler     — loads cached instances, then starts a background network
 *                      fetch and schedules daily automatic refreshes.
 *
 * The API is ready to serve requests before step 4 completes. Incoming searches
 * use the built-in or cached list until the fresh list arrives from searx.space.
 */

import "dotenv/config";
import { BrowserPool } from "./browser/pool.js";
import { InstancePool } from "./instances.js";
import { createServer } from "./server.js";
import { startInstanceScheduler } from "./instance-scheduler.js";

const PORT = Number(process.env.PORT ?? 3030);

async function main(): Promise<void> {
  // Step 1: Instance pool (built-in fallback list, 10 URLs).
  const instancePool = new InstancePool();
  console.log(`[init] Instance pool ready (${instancePool.total} built-in instances)`);

  // Step 2: Browser pool (launches Chromium).
  const browserPool = new BrowserPool();
  console.log("[init] Launching headless Chromium...");
  await browserPool.init();
  console.log(
    `[init] Browser pool ready (max ${process.env.MAX_CONTEXTS ?? 8} contexts)`
  );

  // Step 3: HTTP server.
  const server = await createServer(browserPool, instancePool);
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[init] API listening on http://0.0.0.0:${PORT}`);

  // Step 4: Instance scheduler (non-blocking — uses cached list immediately,
  // then fetches from searx.space in the background).
  await startInstanceScheduler(instancePool, browserPool, server.log);

  // Step 5: Graceful shutdown.
  // Persist EMA stats to disk on exit so the pool stays "warm" across restarts.
  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] Received ${signal}. Saving instance stats...`);
    try {
      const { saveInstances } = await import("./instance-fetcher.js");
      await saveInstances(instancePool.urls, instancePool.serializeStats());
      console.log("[shutdown] Stats saved. Closing browser pool...");
      await browserPool.close();
      console.log("[shutdown] Browser pool closed. Exiting.");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] Failed to save stats or close pool:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
