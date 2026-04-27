# SearXNG Browser API

A zero-cost HTTP search API that aggregates results from 60+ public [SearXNG](https://searxng.github.io/searxng/) instances using a headless Chromium browser (Playwright). It acts as a drop-in alternative to paid search APIs (Google, Bing, Serper, etc.) supporting 10 search categories, parallel instance racing, quality-based result selection, and automatic instance health management.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Data Folder](#data-folder)
- [Environment Variables](#environment-variables)
- [HTTP Endpoints](#http-endpoints)
- [Search Categories](#search-categories)
- [Request Reference](#request-reference)
- [Response Reference](#response-reference)
- [Scoring & Winner Selection](#scoring--winner-selection)
- [Blocklist System](#blocklist-system)
- [Cookie System](#cookie-system)
- [Anti-Detection](#anti-detection)
- [Instance Scoring & Circuit Breaker](#instance-scoring--circuit-breaker)
- [Running the Server](#running-the-server)
- [Docker](#docker)
- [Resource Usage](#resource-usage)
- [Usage Examples](#usage-examples)
- [Updating the Instance List](#updating-the-instance-list)

---

## How It Works

```
Client
  │
  ▼
POST /search  { query, categories, maxResults, debug, ... }
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  Search Engine  (engine.ts)                                  │
│                                                              │
│  Round 1: Pick top-N instances by EMA score                  │
│    └─ Launch N parallel Playwright tabs (staggered ±250ms)   │
│    └─ Navigate: GET /search?q=... (with Referer header)      │
│       ├─ Cloudflare challenge? → wait up to 20s to resolve   │
│       ├─ GET redirected to homepage? → retry as form POST    │
│       └─ Captcha / rate-limit? → fail fast (~1-2s), skip     │
│    └─ Wait up to STAGGER_MS (±15% jitter) for any response   │
│                                                              │
│  If round 1 returns nothing in STAGGER_MS:                   │
│    └─ Round 2: launch reinforcement instances (new N)        │
│    └─ ... up to maxRounds (default 3)                        │
│                                                              │
│  First instance with results → open DECISION_WINDOW_MS timer │
│    └─ Collect competing candidates until window closes       │
│    └─ Filter.pickBest() picks winner by combined score       │
│       ├─ Semantic floor: candidates scoring < 0.4 rejected   │
│       └─ Winner = highest (quality×0.4 + semantic×0.6 + vol) │
│                                                              │
│  Record latency + quality on every instance (EMA update)     │
│  Cancel remaining open tabs immediately via CancelToken      │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
Winner HTML parsed by Cheerio  (parser.ts)
  │   10 category-specific sub-parsers dispatch by CSS class
  ▼
Results filtered by blocklist + language/script detection  (filter.ts)
  │   Blocked results → deniedResults
  ▼
JSON response to client
```

### Key design decisions

| Decision | Why |
|----------|-----|
| Single Chromium process, pooled contexts | One browser process shared across all requests saves ~200 MB vs one-process-per-request |
| Cookie persistence per origin | Challenge cookies (e.g. `cf_clearance`) survive across requests to the same instance |
| Engine preferences via cookies | Each instance activates the right search engines on first use, no repeated `/preferences` visits |
| EMA scoring (not counters) | Recent behaviour dominates — a recovered instance earns its score back in ~20 requests |
| Staggered round logic | Avoids burning all contexts when 1-2 fast instances can answer; reinforcements only if needed |
| Decision window (500 ms) | Lets 2-3 concurrent instances race; the best-quality one wins, not just the fastest |
| Semantic floor (0.4) | Rejects instances that returned superficially plausible but actually irrelevant results |
| Raw body capture (UTF-8) | Bypasses Chromium's charset auto-detection, which mis-renders UTF-8 without a proper `charset` header |
| POST fallback | Handles instances that redirect GET `/search` to their homepage by re-submitting as a form POST |

---

## Project Structure

```
.
├── src/
│   ├── index.ts                  # Entrypoint — bootstraps pools, starts HTTP server
│   ├── server.ts                 # Fastify factory: CORS, rate-limit, routes, graceful shutdown
│   ├── types.ts                  # All TypeScript interfaces (SearchRequest, SearchResponse, etc.)
│   ├── instances.ts              # InstancePool — EMA scoring, circuit breaker, pickN()
│   ├── instance-fetcher.ts       # Fetches/filters live instance list from searx.space
│   ├── instance-scheduler.ts     # Startup cache + periodic refresh every 6h
│   │
│   ├── browser/
│   │   ├── pool.ts               # BrowserPool — Playwright context pool, cookies, preferences
│   │   └── stealth.ts            # 13 anti-detection patches + User-Agent rotation
│   │
│   ├── search/
│   │   ├── engine.ts             # search() / searchBatch() — parallel race, rounds, cancellation
│   │   ├── parser.ts             # parseResults(), parseExtras(), detectBlock() — Cheerio HTML parsing
│   │   └── filter.ts             # Quality scoring, semantic scoring, blocklist, language detection
│   │
│   └── routes/
│       ├── search.ts             # POST /search, POST /search/batch
│       ├── health.ts             # GET /health, GET /instances
│       └── debug.ts              # POST /pool/restart
│
├── data/
│   ├── instances.json            # Cached instance list + EMA scoring state (auto-generated)
│   ├── blocklist.json            # URL/domain blocklist applied to all search results
│   ├── instances_blocklist.json  # Instance URLs permanently excluded from the pool
│   └── README.md                 # Detailed documentation for all data files
│
├── tests/
│   ├── engine.test.ts            # search() orchestration — round logic, zero-result budget
│   ├── instances.test.ts         # InstancePool — scoring, circuit breaker, pickN, persistence
│   └── parser/
│       ├── web.test.ts           # General web result parser
│       ├── news.test.ts          # News result parser
│       ├── images.test.ts        # Image result parser
│       ├── videos.test.ts        # Video result parser
│       ├── music.test.ts         # Music result parser
│       ├── map.test.ts           # Map result parser
│       ├── files.test.ts         # Torrent/files result parser
│       ├── science.test.ts       # Academic paper result parser
│       ├── it.test.ts            # IT package result parser
│       ├── social.test.ts        # Social media result parser
│       └── extras.test.ts        # Answers, infobox, pagination, detectBlock
│
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── tsconfig.json
```

### Key source files

| File | Responsibility |
|------|---------------|
| `instances.ts` | EMA-based instance health. `pickN()` selects top-N available instances with ±0.08 jitter to spread load. |
| `instance-fetcher.ts` | Fetches `searx.space/data/instances.json`, filters by TLS grade (A-/A/A+), uptime ≥ `INSTANCE_MIN_UPTIME`, and `network_type = normal`. |
| `instance-scheduler.ts` | On startup: loads cached list immediately, starts fresh fetch in background. Schedules refresh every 6h. |
| `browser/pool.ts` | Manages a `generic-pool` of Playwright `BrowserContext`s. Handles per-origin cookie persistence, engine preference injection, and resource blocking. |
| `browser/stealth.ts` | 13 JS patches applied via `addInitScript` before every navigation. Removes all browser automation signals. |
| `search/engine.ts` | Round orchestration, stagger timer, decision window, POST fallback, Cloudflare wait, cancellation token, raw body UTF-8 fix. |
| `search/parser.ts` | Dispatches each `<article>` to the correct sub-parser by CSS class. 10 category parsers + extras + pagination + block detection. |
| `search/filter.ts` | Quality scoring (blocklist rate × keyword coverage × domain diversity), semantic scoring (bigram + keyword + fuzzy + consensus), language/script filter, entity-aware domain relaxation, utility page detection. |

---

## Data Folder

See [data/README.md](data/README.md) for full documentation of every file.

### `data/instances.json`

Auto-generated. **Do not edit manually.** Written by `instance-fetcher.ts` on startup and every 6 hours.

```json
{
  "updatedAt": "2026-04-21T13:21:36.586Z",
  "count": 65,
  "urls": ["https://baresearch.org", "https://searxng.site", "..."],
  "stats": {
    "https://baresearch.org": {
      "emaSuccessRate": 0.473,
      "emaLatencyMs":   2968.1,
      "successCount":   1,
      "failureCount":   1
    }
  }
}
```

EMA values are restored on startup so the pool starts warm. Circuit-breaker state (`suspendedUntil`) is intentionally not persisted — a restarted server treats all instances as available, then re-learns which are slow or blocked.

---

### `data/blocklist.json`

Applied to every search result before the response is sent. Results whose URL matches are moved from `results` to `deniedResults`. Has three layers:

| Layer | Applied to | Purpose |
|-------|-----------|---------|
| `domains` | All categories | Exact hostname match — support pages, login walls, app stores, etc. |
| `patterns` | All categories | URL substring match — e.g. `/customer-service`, `/support/`, `/store/apps/` |
| `categoryRules` | Per-category | Extra rules applied only in specific categories (e.g. social media blocked in `general`) |

The **entity-aware relaxation** rule: if a query explicitly names a blocked domain (e.g. `"youtube tutorial"`, `"github actions"`), results from that domain are allowed through even if it appears in the blocklist. This prevents the blocklist from sabotaging queries where the user clearly wants that site.

---

### `data/instances_blocklist.json`

Flat array of SearXNG instance URLs permanently excluded from the pool, even if they appear in the searx.space live list. Use this for instances that are fundamentally broken (inconsistent results, certificate errors, permanent redirects). Temporary failures are handled automatically by the circuit breaker.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3030` | HTTP server port |
| `NODE_ENV` | `development` | `production` disables pino-pretty log formatting |
| `LOG_LEVEL` | `info` | Fastify/pino log level (`debug`, `info`, `warn`, `error`) |
| `MAX_CONTEXTS` | `8` | Playwright BrowserContext pool size. Each context ≈ 100 MB RAM. Requests beyond this limit queue instead of crashing. |
| `SEARCH_TIMEOUT_MS` | `12000` | Navigation timeout per instance per request (ms). |
| `SEARCH_STAGGER_MS` | `5000` | Wait time for a round before launching reinforcement instances (ms). Applied with ±15% jitter per round. |
| `SEARCH_DECISION_WINDOW_MS` | `500` | After the first result arrives, wait this long to collect competing candidates before picking the winner (ms). |
| `INSTANCE_REFRESH_INTERVAL_HOURS` | `6` | Hours between automatic instance list refreshes from searx.space. |
| `INSTANCE_MIN_UPTIME` | `80` | Minimum monthly uptime % required for an instance to be included. |
| `CHROME_PATH` | auto | Path to Chromium binary. Leave empty for Playwright to use its bundled download. In Docker: `/usr/bin/chromium`. |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | — | Set `1` to use the system Chromium instead of Playwright's bundled download (required in Docker). |

Copy `.env.example` to `.env` and adjust as needed.

---

## HTTP Endpoints

### `POST /search`

Execute a single search query.

**Request body** (`application/json`): See [Request Reference](#request-reference).

**Response** (`application/json`): See [Response Reference](#response-reference).

---

### `POST /search/batch`

Execute up to 20 queries in parallel. Concurrency is capped at `MAX_CONTEXTS` to prevent context exhaustion — excess requests queue instead of crashing.

**Request body**: Array of search request objects (same schema as `/search`).

```json
[
  { "query": "javascript", "categories": "general" },
  { "query": "python tutorial", "categories": "videos" },
  { "query": "Florianopolis", "categories": "map" }
]
```

**Response**: Array of response objects in the same order as the requests.

---

### `GET /health`

Returns server status and pool metrics.

```json
{
  "status": "ok",
  "uptime": 3600,
  "pool": {
    "total": 63,
    "available": 59,
    "contexts": 3,
    "contextsBusy": 2,
    "contextCapacity": 8
  }
}
```

`status` is `"degraded"` when fewer than 5 instances are available.

---

### `GET /instances`

Returns all tracked instances with their current health metrics.

```json
{
  "total": 63,
  "available": 59,
  "updatedAt": "2026-04-21T13:21:36.586Z",
  "instances": [
    {
      "url": "https://searxng.site",
      "score": 0.712,
      "available": true,
      "successCount": 14,
      "failureCount": 2,
      "avgLatencyMs": 2340,
      "suspendedUntil": null
    }
  ]
}
```

---

### `POST /pool/restart`

Drains the Playwright browser pool, closes Chromium, and reinitialises everything. Use after a Chromium crash or when memory has grown unexpectedly large.

```json
{ "ok": true }
```

---

## Search Categories

Pass the category name in the `categories` field of the request.

| Category | `categories` value | Description | Category-specific fields in result |
|----------|--------------------|-------------|-------------------------------------|
| General web | `general` | Standard web search | — |
| News | `news` | News articles | `publishedDate`, `source` |
| Images | `images` | Image search | `imageUrl`, `resolution`, `format`, `fileSize`, `thumbnail` |
| Videos | `videos` | Video search (YouTube, Vimeo, Dailymotion, etc.) | `duration`, `publishedDate`, `viewCount`, `author`, `embedUrl` |
| Files | `files` | Torrents and file search | `magnetLink`, `seeders`, `leechers`, `fileSize`, `publishedDate` |
| Science | `science` | Academic papers (arXiv, PubMed, Semantic Scholar, etc.) | `publishedDate`, `author`, `journal`, `tags`, `doi`, `issn`, `pdfUrl` |
| IT | `it` | Code, packages, repos (GitHub, npm, PyPI, Docker Hub, crates.io, etc.) | `packageName`, `author`, `publishedDate`, `tags`, `popularity`, `license` |
| Social Media | `social media` | Fediverse (Mastodon, Lemmy, PeerTube) | `publishedDate`, `socialMeta` |
| Music | `music` | Music search (SoundCloud, Mixcloud, Genius, Bandcamp, Radio Browser) | `duration`, `publishedDate`, `viewCount`, `author`, `embedUrl` |
| Map | `map` | Location search (OpenStreetMap, Photon) | `latitude`, `longitude`, `boundingBox`, `mapLinks` |

---

## Request Reference

### `SearchRequest`

| Field | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `query` | `string` | — | 1–500 chars, **required** | The search query |
| `categories` | `string` | `"general"` | — | Category name (see table above) |
| `language` | `string` | `"auto"` | — | BCP-47 tag (`"pt-BR"`, `"en"`) or `"auto"` |
| `maxResults` | `number` | `10` | 1–50 | Maximum results to return |
| `safeSearch` | `0 \| 1 \| 2` | `2` | — | `0` = off, `1` = moderate, `2` = strict |
| `timeRange` | `string` | `""` | `"day"`, `"week"`, `"month"`, `"year"`, or `""` | Filter results by recency |
| `pageno` | `number` | `1` | 1–50 | Pagination page (1-indexed) |
| `engines` | `string[]` | `[]` | — | Restrict to specific engine names, e.g. `["brave", "duckduckgo"]` |
| `parallelAttempts` | `number` | `5` | 1–6 | Instances queried per round |
| `maxRounds` | `number` | `3` | 1–5 | Reinforcement rounds. Total instances tried = `parallelAttempts × maxRounds` |
| `timeoutMs` | `number` | `12000` | 3000–30000 | Navigation timeout per instance (ms) |
| `debug` | `boolean` | `false` | — | Include candidate scoring details and orchestration log in the response |

---

## Response Reference

### `SearchResponse`

```json
{
  "query": "javascript tutorial",
  "results": [...],
  "total": 10,
  "pageno": 1,
  "hasPrevPage": false,
  "hasNextPage": true,
  "totalPages": 8,
  "estimatedResults": 52000,
  "instanceUsed": "https://searxng.site",
  "elapsedMs": 4820,
  "errors": [],
  "answers": [],
  "infobox": null,
  "suggestions": ["javascript beginner", "javascript es6"],
  "filteredResults": [...],
  "deniedResults": [],
  "totalFiltered": 10,
  "totalDenied": 0,
  "debug": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `query` | `string` | The original query |
| `results` | `SearchResult[]` | Ordered results (up to `maxResults`) |
| `total` | `number` | Count of results returned |
| `pageno` | `number` | Current page (1-indexed) |
| `hasPrevPage` | `boolean` | Whether a previous page exists |
| `hasNextPage` | `boolean` | Whether a next page exists |
| `totalPages` | `number \| null` | Highest page number in the instance's pagination widget (approximation) |
| `estimatedResults` | `number \| null` | Total result count reported by the instance |
| `instanceUsed` | `string` | Base URL of the winning SearXNG instance |
| `elapsedMs` | `number` | Total API response time in milliseconds |
| `errors` | `string[]` | Per-instance error messages (non-fatal) |
| `answers` | `Answer[]?` | Direct answer boxes (e.g. Wikipedia knowledge panel snippets) |
| `infobox` | `Infobox \| null` | Entity sidebar: title, description, image, Wikipedia link |
| `suggestions` | `string[]?` | Related search suggestions |
| `filteredResults` | `SearchResult[]` | Results that passed the blocklist and language filters |
| `deniedResults` | `SearchResult[]` | Results blocked by the blocklist |
| `totalFiltered` | `number` | Count of filtered results |
| `totalDenied` | `number` | Count of denied results |
| `debug` | `object \| undefined` | Present when `debug: true` — see below |

---

### `SearchResult` base fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | `string` | Page title (falls back to URL if empty) |
| `url` | `string` | Canonical URL of the result |
| `content` | `string?` | Snippet or description |
| `engines` | `string[]?` | Search engines that returned this result |
| `score` | `number?` | Relevance score from SearXNG (0–1) |
| `category` | `string?` | Category tag (`"general"`, `"news"`, `"images"`, etc.) |
| `thumbnail` | `string?` | Thumbnail image URL |

Plus category-specific fields — see [Search Categories](#search-categories).

---

### Debug object

When `debug: true` is passed:

```json
{
  "debug": {
    "candidates": [
      {
        "instanceUrl": "https://searxng.site",
        "qualityScore": 0.935,
        "semanticScore": 0.964,
        "totalScore": 1.103,
        "resultCount": 31,
        "isWinner": true,
        "rejectedReason": null,
        "resultSamples": ["JavaScript Tutorial - W3Schools", "..."],
        "allResults": [...]
      }
    ],
    "orchestration": [
      "[round-1] Starting with 5 instances: https://searxng.site, ...",
      "[stagger] Round 1 exceeded 4823ms. Calling reinforcements...",
      "[window] First result from https://searxng.site (31 results). Starting 500ms race.",
      "[window] Decision window closed. Collected 3 candidates."
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `candidates[].qualityScore` | Blocklist pass rate × keyword coverage × domain diversity (0–1) |
| `candidates[].semanticScore` | Bigram + keyword + fuzzy Levenshtein relevance to query (0–1) |
| `candidates[].totalScore` | `quality×0.4 + semantic×0.6 + volumeBonus` |
| `candidates[].rejectedReason` | `"Semantic Floor"` if semantic < 0.4; null otherwise |
| `orchestration` | Step-by-step log: round starts, stagger fires, decision window open/close, semantic floor rejections |

---

## Scoring & Winner Selection

The filter module scores every candidate instance that returned results, then picks the winner. Understanding this system helps explain why a result from a slower instance may win over a faster one.

### Quality score (0–1)

Combines three signals:

```
qualityScore = blocklistPassRate × (0.50 + 0.30 × keywordCoverage + 0.20 × diversityMultiplier)
```

| Signal | Weight | Description |
|--------|--------|-------------|
| Blocklist pass rate | 50% | Fraction of results not blocked and not utility pages (login, register, download-app, etc.) |
| Keyword coverage | 30% | Fraction of passing results that mention ≥1 query keyword in title or content |
| Domain diversity | 20% | Penalty when >50% of results come from the same domain; capped at 0.75× |

**Utility page exemption**: if the query itself expresses intent to find a login/account page (e.g. `"github login"`, `"criar conta netflix"`), utility pages are not penalised.

**Entity-aware diversity exemption**: if the query names the dominant domain (e.g. `"hotmart suporte"` → `hotmart.com`), the diversity penalty is skipped.

---

### Semantic score (0–1)

Title-weighted keyword + phrase matching blended across all results:

| Signal | Points per hit |
|--------|---------------|
| Bigram phrase match in title | +4.0 |
| Exact keyword in title | +3.0 |
| Fuzzy keyword in title (Levenshtein) | +2.0 |
| Exact keyword in content | +1.0 |
| Fuzzy keyword in content | +0.6 |
| Engine consensus (≥2 engines confirm result) | +0.5 |

Final blend: **70% best-result score + 30% average score**. The 30% average component exposes engine contamination (junk results from one engine hiding behind good results from another).

---

### Winner selection

```
totalScore = qualityScore × 0.4 + semanticScore × 0.6 + volumeBonus
volumeBonus = min(0.15, resultCount × 0.015)
```

**Semantic floor**: candidates with `semanticScore < 0.4` are rejected outright — they returned plausible-looking HTML but with results that have no real connection to the query. When all candidates fail the floor, the decision window reopens and the next round of instances is tried.

---

### Language and script filtering

The filter detects the script family of the query (Latin, CJK, Cyrillic, Arabic, other) and blocks results in a different non-Latin script — unless:

- The query contains language-intent keywords (`"translate"`, `"traducao"`, `"japonês"`, etc.), or
- The user's own query is written in a non-Latin script (CJK/Cyrillic query → CJK/Cyrillic results allowed).

This prevents Korean, Japanese, and Chinese Wikipedia from appearing in Latin-script searches, while still supporting queries that deliberately seek non-Latin content.

---

## Blocklist System

`data/blocklist.json` has three layers applied in order:

### 1. Global domain blocklist

Results from these domains are blocked for **all categories**:

- **Support/help pages**: `support.google.com`, `help.instagram.com`, `support.microsoft.com`, etc.
- **Login-walled productivity**: `accounts.google.com`, `mail.google.com`, `docs.google.com`, etc.
- **App stores**: `play.google.com`, `apps.apple.com`, `music.youtube.com`
- **Non-Latin Wikipedia** (for Latin-script queries): `ko.wikipedia.org`, `zh.wikipedia.org`, `ja.wikipedia.org`
- **Messaging web apps**: `web.whatsapp.com`, `web.telegram.org`

### 2. Global URL pattern blocklist

Results whose URL contains these substrings are blocked for **all categories**:

```
/customer-service   /help-center   /support/   /feed/homepage
/store/apps/        /us/app/
```

### 3. Per-category rules (`categoryRules`)

| Category | Extra blocked domains | Extra blocked patterns |
|----------|-----------------------|------------------------|
| `general` | All major social media and video platforms (YouTube, Twitter/X, Facebook, Instagram, TikTok, Reddit, etc.) | `/watch?v=`, `/shorts/`, `/reel/`, `/status/`, `/posts/` |
| `videos` | Twitter/X, Facebook, Instagram, Pinterest, Flickr, Imgur, Giphy | — |
| `images` | YouTube, Twitter/X, Facebook, Instagram, TikTok, Reddit, Twitch | `/watch?v=`, `/shorts/` |
| `news` | `play.google.com`, `apps.apple.com` | `/store/apps/`, `/us/app/` |

Social media is blocked in `general` because post/reel URLs are almost never what a user wants from a web search — but those same URLs are perfectly valid results in a `social media` or `videos` search.

### Entity-aware relaxation

The blocklist includes a special rule: if the query explicitly names the blocked domain, the block is lifted for that request. Examples:

- `"youtube channel monetization"` → `youtube.com` results allowed even though it's in the `general` blocklist
- `"github actions documentation"` → `github.com` results allowed even if it were in a blocklist
- `"google drive storage plans"` → `drive.google.com` allowed despite being in the global blocklist

This is determined by checking whether any identifying part of the blocked domain appears in the query text.

---

## Cookie System

The browser pool injects preference cookies into each SearXNG instance on first use. This ensures consistent behaviour across all 60+ instances without navigating to each instance's `/preferences` page on every request.

### Engine preferences

On the first request to a new instance origin, `BrowserPool.initializePreferences()` injects:

| Cookie | Purpose |
|--------|---------|
| `enabled_engines` | Activates curated high-quality engines per category (Bing, Google, Brave, DuckDuckGo, SoundCloud, GitHub, arXiv, OpenStreetMap, Photon, Genius, Bandcamp, Mixcloud, etc.) |
| `disabled_engines` | Disables slow or low-quality engines (Naver, Presearch, Wiby, etc.) |
| `theme` | Forces the `simple` theme — the HTML parser depends on its markup structure |
| `method` | Forces `GET` requests to avoid unnecessary POST redirects |
| `url_formatting` | Forces `full` URL display — ensures raw canonical URLs in results |

### Per-request cookies

On every request, two additional cookies are injected to match the URL parameters:

| Cookie | Value |
|--------|-------|
| `language` | From `req.language` (default `"auto"`) |
| `safesearch` | From `req.safeSearch` (default `2`) |

### Persistence

Cookies are captured and saved per-origin after every request. This means:
- Challenge cookies (e.g. Cloudflare `cf_clearance`) survive across requests to the same instance
- When the instance list refreshes, cookies for removed instances are pruned automatically
- A fresh instance receives its preference cookies on the very first request

### Cookie format

SearXNG uses Python's Morsel encoding: commas inside cookie values are stored as `\054` (octal 44). Example:

```
enabled_engines = "bing__general\054google__general\054duckduckgo__general\054..."
```

---

## Anti-Detection

Every Playwright page receives 13 JavaScript patches via `addInitScript` before navigation:

| Patch | What it masks |
|-------|--------------|
| `navigator.webdriver` | Removed — the most common bot-detection signal |
| `window.chrome` | Populated with realistic Chrome extension API stubs |
| `navigator.plugins` | Faked with PDF Viewer entries (empty plugin list = bot signal) |
| `navigator.languages` | Set to `['pt-BR', 'pt', 'en-US', 'en']` matching `Accept-Language` header |
| Permissions API | Notifications query returns real browser behaviour |
| WebGL vendor/renderer | Masked from `"Google SwiftShader"` to `"Intel Iris OpenGL Engine"` |
| Canvas fingerprint | Single-pixel noise makes every context unique |
| ChromeDriver artifacts | Removes `__playwright`, `__pw_manual`, CDP globals |
| `history.length` | Simulates non-trivial browsing history (≥2) |
| `hardwareConcurrency` / `deviceMemory` | Set to `8` / `8` (realistic desktop values) |
| Screen colour depth | Normalised to `24` |
| AudioContext | Imperceptible noise (±1e-7) varies the audio fingerprint hash |
| Network connection | `rtt=50ms`, `downlink=10Mbps`, `effectiveType=4g` |

Additional context-level measures:
- Random `User-Agent` per BrowserContext (Chrome 120-124 and Firefox 122-124 on Linux)
- `--disable-blink-features=AutomationControlled` Chromium launch flag
- `locale=pt-BR`, `timezoneId=America/Sao_Paulo`
- Images, fonts, stylesheets, and media **blocked at the network route level** (reduces RAM and eliminates trackers as a fingerprint surface)
- `Referer` header set to the instance's own origin on every navigation

---

## Instance Scoring & Circuit Breaker

### Score formula

Each instance maintains an EMA-based composite score (0–1):

```
latencyScore = pow(max(0, 1 − (emaLatencyMs − 300) / 5700), 1.5)
score        = emaSuccessRate × 0.65 + latencyScore × 0.35
```

| EMA field | Initial value | Description |
|-----------|-------------|-------------|
| `emaSuccessRate` | `0.5` | EMA of outcomes (1=success, 0=failure), α=0.1. Quality score (0–1) from `filter.ts` is used as the success value — a result with quality 0.0 acts like a failure. |
| `emaLatencyMs` | `3000` | EMA of round-trip latency for successful requests, α=0.1 |

A fresh instance starts at score ≈ **0.46**. An instance with 300 ms average latency and 100% success rate scores ≈ **0.98**.

### Instance selection

`pickN(n)` adds `±0.08` random jitter to each instance score before sorting. This distributes load across similarly-scored instances instead of always routing every request to the single highest scorer. Within a round, individual instance launches are further staggered by ±250 ms to avoid a synchronised burst pattern.

### Circuit breaker

On each failure, `recordFailure()` increments `consecutiveFailures` and suspends the instance:

```
suspendDuration = min(2^(consecutiveFailures − 1), 64) minutes
```

| Consecutive failures | Suspension |
|---------------------|------------|
| 1 | 1 min |
| 2 | 2 min |
| 3 | 4 min |
| 4 | 8 min |
| 5 | 16 min |
| 6+ | 32–64 min |

A success resets `consecutiveFailures` to 0 and lifts the suspension immediately. If **all** instances are suspended (e.g. after an IP ban wave), `pickN` falls back to returning the least-penalised suspended instances so the system never stalls completely.

### Instance source filtering

`instance-fetcher.ts` applies these filters to the raw searx.space list before any instance enters the pool:

| Filter | Criterion |
|--------|-----------|
| Network type | `normal` only — excludes Tor and I2P instances |
| TLS grade | `A-`, `A`, or `A+` only — instances with weak TLS are excluded |
| Monthly uptime | ≥ `INSTANCE_MIN_UPTIME` % (default 80%) |

### Persistence

EMA state is saved to `data/instances.json` after every instance list refresh. On startup, the saved state is restored immediately so the pool is warm — previously learned scores and latencies are available from the very first request.

---

## Running the Server

### Prerequisites

- Node.js ≥ 20
- npm

### Development (hot-reload)

```bash
npm install
npm run dev
```

### Production build

```bash
npm run build
npm start
```

### TypeScript check (no emit)

```bash
npm run lint
```

### Tests

```bash
npm test              # run all tests once
npm run test:watch    # watch mode
```

---

## Docker

### Build and run

```bash
docker build -t searxng-browser-api .

docker run -d \
  --shm-size=512m \
  --cap-add=SYS_ADMIN \
  -p 3030:3030 \
  searxng-browser-api
```

**Mandatory flags:**
- `--shm-size=512m` — Chromium uses `/dev/shm` for IPC; without this flag it crashes under load
- `--cap-add=SYS_ADMIN` — Required for Chromium's namespace sandbox

### Persist EMA scores across container restarts

```bash
docker run -d \
  --shm-size=512m \
  --cap-add=SYS_ADMIN \
  -p 3030:3030 \
  -v search-api-data:/app/data \
  searxng-browser-api
```

The named volume persists `data/instances.json` (EMA scores, instance list) and the blocklist files across container restarts.

### Docker Compose / Swarm

```bash
# Standalone
docker compose up -d

# Swarm
docker stack deploy -c docker-compose.yml search-api
```

### Override environment variables

```bash
docker run -d \
  --shm-size=512m \
  --cap-add=SYS_ADMIN \
  -p 3030:3030 \
  -e MAX_CONTEXTS=4 \
  -e SEARCH_TIMEOUT_MS=10000 \
  -e NODE_ENV=production \
  -e CHROME_PATH=/usr/bin/chromium \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  searxng-browser-api
```

---

## Resource Usage

| State | RAM | CPU |
|-------|-----|-----|
| Idle (server started) | ~200 MB | ~0% |
| 1 active search | ~300 MB | ~15% |
| 4 concurrent searches | ~600 MB | ~35% |
| 8 concurrent searches (max) | ~900 MB | ~60% |
| 30+ queued requests | ~900 MB stable | ~60% |

Requests beyond `MAX_CONTEXTS` queue inside `generic-pool` — RAM stays flat regardless of queue depth.

### Tuning for low-memory environments

```bash
MAX_CONTEXTS=2          # 2 parallel searches max → ~400 MB peak
SEARCH_TIMEOUT_MS=8000  # Fail faster → lower worst-case latency
```

### Tuning for high-throughput environments

```bash
MAX_CONTEXTS=16                  # 16 parallel searches → ~1.6 GB RAM
SEARCH_STAGGER_MS=3000           # Start reinforcements faster
SEARCH_DECISION_WINDOW_MS=300    # Accept results sooner
```

---

## Usage Examples

### cURL

```bash
# General web search
curl -s -X POST http://localhost:3030/search \
  -H "Content-Type: application/json" \
  -d '{"query": "javascript closures", "maxResults": 5}'

# News with time filter
curl -s -X POST http://localhost:3030/search \
  -H "Content-Type: application/json" \
  -d '{"query": "AI news", "categories": "news", "timeRange": "week"}'

# Image search
curl -s -X POST http://localhost:3030/search \
  -H "Content-Type: application/json" \
  -d '{"query": "sunset beach", "categories": "images", "safeSearch": 1}'

# Academic papers
curl -s -X POST http://localhost:3030/search \
  -H "Content-Type: application/json" \
  -d '{"query": "transformer attention mechanism", "categories": "science", "maxResults": 10}'

# Music
curl -s -X POST http://localhost:3030/search \
  -H "Content-Type: application/json" \
  -d '{"query": "lofi hip hop", "categories": "music", "maxResults": 5}'

# Map / location
curl -s -X POST http://localhost:3030/search \
  -H "Content-Type: application/json" \
  -d '{"query": "Parque Ibirapuera São Paulo", "categories": "map"}'

# Batch: 3 queries in parallel
curl -s -X POST http://localhost:3030/search/batch \
  -H "Content-Type: application/json" \
  -d '[
    {"query": "javascript", "categories": "general"},
    {"query": "javascript tutorial", "categories": "videos"},
    {"query": "react npm package", "categories": "it"}
  ]'

# Debug mode — inspect candidate scores and round orchestration
curl -s -X POST http://localhost:3030/search \
  -H "Content-Type: application/json" \
  -d '{"query": "python", "debug": true}' | jq '.debug.orchestration'

# Check instance health
curl -s http://localhost:3030/instances | jq '[.instances[] | select(.available)] | length'
```

### JavaScript (fetch)

```js
const res = await fetch("http://localhost:3030/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    query: "machine learning",
    categories: "science",
    maxResults: 10,
    language: "en",
  }),
});

const data = await res.json();
data.results.forEach(r => {
  console.log(r.title, r.url);
  if (r.doi)    console.log("  DOI:", r.doi);
  if (r.pdfUrl) console.log("  PDF:", r.pdfUrl);
  if (r.author) console.log("  By:", r.author);
});
```

### Python

```python
import requests

# News search
resp = requests.post("http://localhost:3030/search", json={
    "query": "climate change",
    "categories": "news",
    "timeRange": "week",
    "maxResults": 20,
    "language": "en",
})
for r in resp.json()["results"]:
    print(r["title"], "-", r.get("source", ""), r.get("publishedDate", ""))

# Debug: see why an instance won
resp = requests.post("http://localhost:3030/search", json={
    "query": "quantum computing",
    "debug": True,
})
data = resp.json()
print("Winner:", data["instanceUsed"])
print("Elapsed:", data["elapsedMs"], "ms")
for c in data["debug"]["candidates"]:
    print(f"  {c['instanceUrl']}: quality={c['qualityScore']:.3f} "
          f"semantic={c['semanticScore']:.3f} winner={c['isWinner']}")
```

---

## Updating the Instance List

The instance list auto-refreshes every `INSTANCE_REFRESH_INTERVAL_HOURS` hours (default: 6) from [searx.space](https://searx.space). To force an immediate refresh, restart the server.

### Manually build the list

```bash
curl -s "https://searx.space/data/instances.json" | \
  node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    Object.entries(d.instances)
      .filter(([, v]) =>
        v.network_type === 'normal' &&
        ['A+','A','A-'].includes(v.tls?.grade) &&
        (v.uptime?.uptimeMonth ?? 0) >= 80
      )
      .forEach(([url]) => console.log(url))
  "
```

### Permanently exclude an instance

Add its URL to `data/instances_blocklist.json` (both `https://` and `http://`, with and without `www.`). It will be excluded on the next startup or 6-hour refresh without any code change. See [data/README.md](data/README.md) for the difference between the blocklist and the circuit breaker.

### Reset all learned EMA scores

```bash
rm data/instances.json
```

The file is recreated on the next startup from a fresh searx.space fetch, with all instances at their neutral default score (≈0.46).
