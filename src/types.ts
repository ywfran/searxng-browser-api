/**
 * @file types.ts
 * Shared TypeScript interfaces and types for the SearXNG Browser API.
 */

/** Parameters accepted by the search endpoints. */
export interface SearchRequest {
  /** The search query string. */
  query: string;
  /** BCP-47 language tag, "all", or "auto" (default). */
  language?: string;
  /** SearXNG category name: "general", "news", "images", "videos", "files", "science", "it", "social media", "music", "map". Default: "general". */
  categories?: string;
  /** Restrict results to specific engines, e.g. ["brave", "duckduckgo"]. */
  engines?: string[];
  /** Pagination page number, 1-indexed. Default: 1. */
  pageno?: number;
  /** Maximum number of results to return. Default: 10, max: 50. */
  maxResults?: number;
  /** Per-navigation timeout in milliseconds. Default: 12000. */
  timeoutMs?: number;
  /** Number of SearXNG instances to query in parallel per round. Default: 5, max: 6. */
  parallelAttempts?: number;
  /**
   * Maximum number of retry rounds. If all instances in a round fail, a fresh
   * batch (excluding already-tried URLs) is selected for the next round.
   * Total instances tried = parallelAttempts × maxRounds. Default: 3.
   */
  maxRounds?: number;
  /** Filter results by recency. Empty string means no filter. */
  timeRange?: "day" | "week" | "month" | "year" | "";
  /** SafeSearch level: 0 = off, 1 = moderate, 2 = strict. Default: 2. */
  safeSearch?: 0 | 1 | 2;
}

/** A single search result item. */
export interface SearchResult {
  /** Page title. */
  title: string;
  /**
   * Canonical URL of the result.
   * For `category=images` this is the source page where the image was found.
   * For all other categories this is the target page URL.
   */
  url: string;
  /** Snippet / description extracted from the result page. */
  content?: string;
  /** Search engines that returned this result. */
  engines?: string[];
  /** Relevance score provided by SearXNG (0–1), when available. */
  score?: number;
  /** SearXNG category tag. */
  category?: string;
  /** Thumbnail URL (small preview image served via Bing CDN or the instance proxy). */
  thumbnail?: string;

  // ─── News-specific fields (populated when category === "news") ──────────────
  /**
   * Publisher or outlet name extracted from the SearXNG highlight bar,
   * e.g. "Exame", "Diário do Comércio". Populated for `category=news` results.
   */
  source?: string;

  // ─── Video-specific fields (populated when category === "videos") ───────────
  /** Video duration, e.g. "1:13:41" or "02:39". */
  duration?: string;
  /** ISO 8601 publish date reported by the instance, when available. */
  publishedDate?: string;
  /** Raw view count string, e.g. "4" or "1.2M". */
  viewCount?: string;
  /** Channel or uploader name. */
  author?: string;
  /** Embed URL for inline playback (e.g. YouTube nocookie embed URL). */
  embedUrl?: string;

  // ─── Image-specific fields (populated when category === "images") ───────────
  /** Direct URL to the full-resolution image file. */
  imageUrl?: string;
  /** Image dimensions reported by SearXNG, e.g. "1000 x 667". */
  resolution?: string;
  /** Image format reported by SearXNG, e.g. "jpeg", "png". */
  format?: string;
  /**
   * File size. For images: e.g. "125.78 KB". For files/torrents: e.g. "202.18 GB".
   */
  fileSize?: string;

  // ─── Files/torrent-specific fields (populated when category === "files") ────
  /** Magnet URI for direct torrent download. */
  magnetLink?: string;
  /**
   * Number of active seeders, or `null` when the tracker reports N/A.
   */
  seeders?: number | null;
  /**
   * Number of active leechers, or `null` when the tracker reports N/A.
   */
  leechers?: number | null;

  // ─── Map-specific fields (populated when category === "map") ────────────────
  /** Latitude of the map result, extracted from data-map-lat. */
  latitude?: number;
  /** Longitude of the map result, extracted from data-map-lon. */
  longitude?: number;
  /**
   * Bounding box as [minLat, maxLat, minLon, maxLon], parsed from data-map-boundingbox.
   * Useful for fitting a map viewport to the result area.
   */
  boundingBox?: number[];
  /**
   * Key-value pairs from the result's metadata table (e.g. website, Wikipedia,
   * Wikidata, address). Keys are the raw label text from `<th>`.
   */
  mapLinks?: Record<string, string>;

  // ─── Social media-specific fields (populated when category === "social media") ──
  /**
   * Raw social metadata line rendered by SearXNG below the title.
   * Content is locale-dependent and engine-dependent, e.g.:
   *   - Lemmy community: "inscritos: 1056 | publicações: 85 | usuários ativos: 29"
   *   - Lemmy post:      "▲ 1 ▼ 0 | usuário: RSS Bot | comentários: 0 | comunidade: Lobste.rs"
   *   - Mastodon user:   follower count in the title (already included there)
   */
  socialMeta?: string;

  // ─── IT/package-specific fields (populated when category === "it", result-packages) ─
  /** Package or repository identifier, e.g. "100hellos/javascript". */
  packageName?: string;
  /** Raw popularity string reported by the engine, e.g. "3.0K pulls, 0 stars" or "263675 stars". */
  popularity?: string;
  /** Software license, e.g. "MIT License". */
  license?: string;

  // ─── Science/paper-specific fields (populated when category === "science") ──
  /** Journal or preprint server name, e.g. "bioRxiv", "Nature". */
  journal?: string;
  /** Subject tags / arXiv category codes, e.g. "cs.PL, cs.CR". */
  tags?: string;
  /** Digital Object Identifier, e.g. "10.1145/3548606.3560597". */
  doi?: string;
  /** ISSN of the journal, e.g. "2692-8205". */
  issn?: string;
  /** Direct URL to the full-text PDF, when provided by the engine. */
  pdfUrl?: string;
}

/** A direct answer box (e.g. from Wikipedia or a knowledge panel). */
export interface Answer {
  /** Answer text. */
  text: string;
  /** Source URL for the answer, if provided. */
  url?: string;
}

/** Wikipedia / Wikidata infobox shown in the sidebar. */
export interface Infobox {
  /** Entity name / title. */
  title: string;
  /** Short description or biography. */
  description: string;
  /** Proxied image URL served by the SearXNG instance. */
  imageUrl?: string;
  /** Wikipedia article URL. */
  wikiUrl?: string;
}

/** Full response returned by POST /search. */
export interface SearchResponse {
  /** The original query string. */
  query: string;
  /** Ordered list of search results. */
  results: SearchResult[];
  /** Number of results returned on this page (≤ maxResults). */
  total: number;
  /** Current page number (1-indexed). */
  pageno: number;
  /** Whether a previous page of results exists. */
  hasPrevPage: boolean;
  /** Whether a next page of results exists. */
  hasNextPage: boolean;
  /**
   * Last page number visible in the instance's pagination widget.
   * This is an approximation — SearXNG shows up to ~10 page links at a time.
   * `null` when the instance does not render a numbered pagination bar.
   */
  totalPages: number | null;
  /**
   * Estimated total result count reported by the instance (from `#result_count`).
   * Uses locale-independent parsing — both `.` and `,` thousand-separators are handled.
   * `null` when the element is absent.
   */
  estimatedResults: number | null;
  /** Base URL of the SearXNG instance that won the race. */
  instanceUsed: string;
  /** Total elapsed time in milliseconds, measured from the API handler. */
  elapsedMs: number;
  /** Non-fatal errors from individual instance attempts. */
  errors: string[];
  /** Direct answer boxes, if present on the results page. */
  answers?: Answer[];
  /** Entity infobox from the sidebar, if present. */
  infobox?: Infobox;
  /** Related search suggestions from the sidebar. */
  suggestions?: string[];
  /** Results that passed the quality/blocklist filter. */
  filteredResults: SearchResult[];
  /** Results that were filtered out by the blocklist. */
  deniedResults: SearchResult[];
  /** Count of results in the filtered list. */
  totalFiltered: number;
  /** Count of results in the denied list. */
  totalDenied: number;
  /** Optional telemetry for auditing search decisions. */
  debug?: {
    /** Detailed info on every candidate considered during the decision window. */
    candidates: {
      instanceUrl: string;
      qualityScore: number;
      semanticScore: number;
      totalScore: number;
      resultCount: number;
      isWinner: boolean;
      rejectedReason?: string;
      resultSamples: string[]; // Added: sample titles for manual verification
      allResults: SearchResult[]; // Added: full result set for deep verification
    }[];
    /** Log of orchestration events (rounds, staggers, timeouts). */
    orchestration: string[];
  };
}

/** Runtime health metrics for a single SearXNG instance. */
export interface InstanceStats {
  /** Base URL of the instance. */
  url: string;
  /** Composite score 0.0–1.0 (65% success rate + 35% latency). */
  score: number;
  /** Whether the instance is currently accepting requests. */
  available: boolean;
  /** Cumulative successful request count. */
  successCount: number;
  /** Cumulative failed request count. */
  failureCount: number;
  /** Average latency of successful requests in milliseconds. */
  avgLatencyMs: number;
  /** ISO 8601 timestamp until which the instance is suspended, if applicable. */
  suspendedUntil?: string;
}

/** Response body for GET /health. */
export interface HealthResponse {
  status: "ok" | "degraded";
  /** Server uptime in seconds. */
  uptime: number;
  pool: {
    /** Total number of tracked SearXNG instances. */
    total: number;
    /** Number of instances currently accepting requests. */
    available: number;
    /** Active Playwright BrowserContext count. */
    contexts: number;
    /** BrowserContexts currently borrowed from the pool. */
    contextsBusy: number;
    /** Maximum configured BrowserContext pool size. */
    contextCapacity: number;
  };
}
