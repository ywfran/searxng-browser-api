# data/

This folder contains configuration files and runtime-generated data used by the API.

| File | Tracked in Git | Description |
|------|---------------|-------------|
| `blocklist.json` | Yes | Filters applied to every search result |
| `instances_blocklist.json` | Yes | SearXNG instances permanently excluded from the pool |
| `instances.json` | **Yes** | Live instance list + EMA scoring state — tracked because good instances persist for weeks or months |

---

## blocklist.json

Controls which search results are **blocked** — moved from `results` to `deniedResults` in the API response — before anything reaches the caller.

There are three layers of filtering:

### `domains` — global domain blocklist

Results whose URL hostname matches any entry here are blocked for **all categories**.

```json
"domains": [
  "support.google.com",
  "accounts.google.com",
  ...
]
```

**Why these domains?**

| Group | Domains | Reason |
|-------|---------|--------|
| Support / help pages | `support.google.com`, `support.youtube.com`, `support.microsoft.com`, `support.apple.com`, `help.instagram.com`, `help.twitter.com`, `help.facebook.com` | These are help-desk and FAQ pages, never useful as organic search results |
| Non-Latin Wikipedia | `ko.wikipedia.org`, `zh.wikipedia.org`, `ja.wikipedia.org` | Korean, Chinese and Japanese Wikipedia appear in Latin-script queries when SearXNG instances use multi-language engines; they are rarely useful for non-speakers |
| App stores | `music.youtube.com`, `play.google.com`, `apps.apple.com` | App store listings appear in many queries but almost never contain the actual content the user is looking for |
| Google productivity | `accounts.google.com`, `mail.google.com`, `calendar.google.com`, `docs.google.com`, `drive.google.com` | Login walls and personal-data pages — unusable as search results |
| Messaging web apps | `web.whatsapp.com`, `web.telegram.org` | Open a login page or a specific chat; not content |

---

### `patterns` — global URL path blocklist

Results whose URL contains any of these substrings are blocked for **all categories**.

```json
"patterns": [
  "/customer-service",
  "/help-center",
  "/support/",
  "/feed/homepage",
  "/store/apps/",
  "/us/app/"
]
```

| Pattern | Reason |
|---------|--------|
| `/customer-service`, `/help-center`, `/support/` | Generic support-section URLs across many sites — rarely useful organic content |
| `/feed/homepage` | LinkedIn's generic feed page — not a real result |
| `/store/apps/`, `/us/app/` | Google Play and Apple App Store deep-links |

---

### `categoryRules` — per-category blocklist

Some domains and patterns are only blocked for specific categories, because the same domain may be perfectly valid in one category but noise in another.

#### `general`

Social media and video platforms are blocked in **general** web search because their content (posts, reels, tweets) is almost never what a user wants when doing a regular web search. They are **not** blocked in `videos`, `images`, or `social media` searches.

```
Blocked: youtube.com, twitter.com / x.com, facebook.com, instagram.com,
         tiktok.com, pinterest.com, linkedin.com, reddit.com, twitch.tv,
         vimeo.com, dailymotion.com, flickr.com, imgur.com, giphy.com

Blocked patterns: /watch?v=, /shorts/, /reel/, /status/, /posts/
```

#### `videos`

For **video** searches, non-video image/GIF hosting sites are blocked (they would appear because some have embedded video players but serve no actual video content for search purposes).

```
Blocked: twitter.com / x.com, facebook.com, instagram.com,
         pinterest.com, flickr.com, imgur.com, giphy.com
```

#### `images`

For **image** searches, sites that primarily serve videos or social text feeds are blocked.

```
Blocked: youtube.com, twitter.com / x.com, facebook.com, instagram.com,
         tiktok.com, reddit.com, twitch.tv

Blocked patterns: /watch?v=, /shorts/
```

#### `news`

For **news** searches, app store listings that sometimes appear in news engines are blocked.

```
Blocked: play.google.com, apps.apple.com
Blocked patterns: /store/apps/, /us/app/
```

---

### How to add entries

To permanently block a domain in all categories:

```json
"domains": [
  "example.com",
  "subdomain.example.com"
]
```

To block a URL path pattern in all categories:

```json
"patterns": [
  "/unwanted-path/"
]
```

To block only in a specific category, add it under `categoryRules`:

```json
"categoryRules": {
  "general": {
    "domains": ["newdomain.com"],
    "patterns": ["/unwanted/"]
  }
}
```

Changes take effect immediately on the next server restart (the file is read at startup).

---

## instances_blocklist.json

A flat array of SearXNG instance URLs that are **permanently excluded** from the pool, even if they appear in the live list from [searx.space](https://searx.space).

```json
[
  "https://www.gruble.de",
  "http://www.gruble.de",
  ...
]
```

The blocklist is applied every time the instance pool is updated — both at startup and during the automatic 6-hour refresh.

### Why are some instances blocked?

| Instance | Reason |
|----------|--------|
| `gruble.de` (all variants) | Extremely inconsistent results — queries return completely unrelated content with no correlation to the search terms; effectively unusable as a search source |
| `searx.perennialte.ch` (all variants) | Certificate issues and persistent redirect loops that cause navigation timeouts on every attempt |

> **Note:** Include both `https://` and `http://` variants (and `www.` / non-`www.`) when adding an instance, as searx.space may list any combination.

### How to add an instance to the blocklist

Add the URL exactly as it appears in `/instances` or in the searx.space list:

```json
[
  "https://problem-instance.example.com",
  "http://problem-instance.example.com"
]
```

The instance will be excluded on the next server restart or instance list refresh. No code changes required.

### Difference from circuit breaker suspension

The circuit breaker (in `instances.ts`) **temporarily** suspends instances that fail — they recover automatically after a back-off period. The `instances_blocklist.json` is a **permanent** exclusion: use it only for instances that are fundamentally broken or hostile (persistent CAPTCHA, certificate errors, malicious redirects).

| Mechanism | Duration | When to use |
|-----------|----------|-------------|
| Circuit breaker | Minutes to hours, auto-recovers | Temporary failures, overloaded instances |
| `instances_blocklist.json` | Permanent until manually removed | CAPTCHA walls, broken TLS, hostile instances |

---

## instances.json

**Auto-generated. Do not edit manually.**

This file is written by `instance-fetcher.ts` and updated automatically every 6 hours (configurable via `INSTANCE_REFRESH_INTERVAL_HOURS`). It persists across server restarts so the instance pool starts warm without re-fetching from searx.space. Because good instances remain stable for weeks or months, the file is tracked in Git so users start with a pre-scored pool instead of neutral defaults.

### Structure

```json
{
  "updatedAt": "2026-04-21T13:21:36.586Z",
  "count": 65,
  "urls": [
    "https://baresearch.org",
    "https://searxng.site",
    "..."
  ],
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

| Field | Description |
|-------|-------------|
| `updatedAt` | ISO 8601 timestamp of the last successful searx.space fetch |
| `count` | Number of instances currently in the pool |
| `urls` | Array of instance base URLs (no trailing slash) |
| `stats` | EMA scoring state per instance URL |

### The `stats` object

Each entry stores the **Exponential Moving Average** state for one instance:

| Field | Initial value | Description |
|-------|-------------|-------------|
| `emaSuccessRate` | `0.5` | EMA of request outcomes (1 = success, 0 = failure). α = 0.1 (~20-request window). A failed request with quality 0 acts like a failure even if the HTTP response was 200. |
| `emaLatencyMs` | `3000` | EMA of round-trip latency in ms for successful requests. Lower is better. |
| `successCount` | `0` | Cumulative successful requests (display only, not used in scoring). |
| `failureCount` | `0` | Cumulative failed requests (display only, not used in scoring). |

### Score formula

```
latencyScore = pow(max(0, 1 − (emaLatencyMs − 300) / 5700), 1.5)
score        = emaSuccessRate × 0.65 + latencyScore × 0.35
```

A new instance with default values (`emaSuccessRate=0.5`, `emaLatencyMs=3000`) scores **≈ 0.46**. As it accumulates successful fast responses, its score rises toward 1.0. As it accumulates failures or slow responses, it drops toward 0.

### Resetting scores

To reset all learned scores (start fresh as if no requests have been made):

```bash
rm data/instances.json
```

The file will be recreated on the next startup from a fresh searx.space fetch, with all instances at their default neutral score.
