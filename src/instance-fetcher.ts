/**
 * @file instance-fetcher.ts
 * Fetches the live SearXNG instance list from searx.space, applies quality
 * filters, and persists the result to disk for fast cold-start recovery.
 *
 * The searx.space JSON API is the authoritative source:
 * https://searx.space/data/instances.json
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import type { PersistedInstanceStats } from "./instances.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const SPACE_API_URL = "https://searx.space/data/instances.json";

/**
 * Minimum monthly uptime percentage an instance must have to be included.
 * Configurable via INSTANCE_MIN_UPTIME env var. Default: 80.
 */
const MIN_UPTIME = Number(process.env.INSTANCE_MIN_UPTIME ?? "80");

/** Acceptable TLS grades — anything below A- is excluded. */
const ACCEPTED_TLS_GRADES = new Set(["A+", "A", "A-"]);

const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "instances.json");

// ─── Types ────────────────────────────────────────────────────────────────────

interface SpaceInstance {
  network_type?: string;
  tls?: { grade?: string };
  uptime?: { uptimeMonth?: number };
  timing?: {
    search?: { all?: { value?: number }; error?: number };
  };
}

interface SpaceApiResponse {
  instances: Record<string, SpaceInstance>;
}

/** Shape of the JSON file written to and read from disk. */
export interface PersistedInstanceData {
  /** ISO 8601 timestamp of when the list was last fetched. */
  updatedAt: string;
  /** Number of instances in the list. */
  count: number;
  /** Cleaned instance base URLs (no trailing slash). */
  urls: string[];
  /**
   * EMA scoring state keyed by instance URL.
   * Present in files written after EMA persistence was introduced.
   * Absent in older files — the pool starts at neutral 0.5 for all instances.
   * Instances removed from searx.space are automatically absent here on the
   * next save, so stale entries never accumulate.
   */
  stats?: Record<string, PersistedInstanceStats>;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/**
 * Applies quality filters to the raw searx.space data and returns a list of
 * usable instance URLs.
 *
 * Exclusion criteria:
 * - Tor / non-normal network type
 * - TLS grade below A- (misconfigured or weak encryption)
 * - Monthly uptime below MIN_UPTIME
 * - 100% search error rate (instance responds but always fails queries)
 *
 * @param data - Raw parsed response from the searx.space API.
 * @returns Array of cleaned instance URLs sorted alphabetically.
 */
function filterInstances(data: SpaceApiResponse): string[] {
  return Object.entries(data.instances)
    .filter(([, info]) => {
      if (info.network_type !== "normal") return false;

      const tlsGrade = info.tls?.grade;
      if (tlsGrade && !ACCEPTED_TLS_GRADES.has(tlsGrade)) return false;

      const uptime = info.uptime?.uptimeMonth;
      if (uptime !== undefined && uptime < MIN_UPTIME) return false;

      // Exclude instances whose search is currently returning only errors.
      // A missing error count is fine — the instance may just not report it.
      const searchErrors = info.timing?.search?.error;
      const searchCount = info.timing?.search?.all?.value;
      if (
        searchErrors !== undefined &&
        searchCount !== undefined &&
        searchCount > 0 &&
        searchErrors / searchCount >= 1
      )
        return false;

      return true;
    })
    .map(([url]) => url.replace(/\/$/, "")) // strip trailing slash for consistency
    .sort();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches the searx.space instance list, applies quality filters, and returns
 * the resulting array of base URLs.
 *
 * @throws {Error} If the network request fails or the response is not OK.
 */
export async function fetchInstances(): Promise<string[]> {
  const response = await fetch(SPACE_API_URL, {
    headers: {
      "User-Agent": "SearXNG-Browser-API/1.0 (instance-list-updater; +https://github.com)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `searx.space API responded with HTTP ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as SpaceApiResponse;
  return filterInstances(data);
}

/**
 * Persists an instance URL list and optional EMA scoring state to
 * `data/instances.json`. Creates the `data/` directory if it does not exist.
 *
 * Instances absent from `urls` are automatically excluded from `stats` in the
 * written file — stale entries never accumulate even if the caller passes a
 * snapshot that contains removed URLs.
 *
 * @param urls  - Filtered instance URLs to persist.
 * @param stats - Optional EMA snapshot from {@link InstancePool.serializeStats}.
 */
export async function saveInstances(
  urls: string[],
  stats?: Record<string, PersistedInstanceStats>
): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  // Only keep stats for URLs that are still in the active list.
  // This guarantees no stale entries survive when an instance is removed.
  const activeStats: Record<string, PersistedInstanceStats> | undefined =
    stats
      ? Object.fromEntries(
          urls.flatMap((u) => (stats[u] ? [[u, stats[u]]] : []))
        )
      : undefined;

  const payload: PersistedInstanceData = {
    updatedAt: new Date().toISOString(),
    count: urls.length,
    urls,
    ...(activeStats && Object.keys(activeStats).length > 0
      ? { stats: activeStats }
      : {}),
  };

  await writeFile(DATA_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

/**
 * Loads the previously persisted instance list from disk.
 *
 * @returns The persisted data, or `null` if the file does not exist or is corrupt.
 */
export async function loadSavedInstances(): Promise<PersistedInstanceData | null> {
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as PersistedInstanceData;
  } catch {
    return null;
  }
}
