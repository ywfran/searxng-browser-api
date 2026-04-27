/**
 * @file search/parser.ts
 * HTML parsing utilities for SearXNG result pages.
 *
 * Uses Cheerio (server-side jQuery) for synchronous, lightweight DOM traversal.
 * All selectors are based on the SearXNG `simple` theme markup.
 */

import * as cheerio from "cheerio";
import type { SearchResult, Answer, Infobox } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extracts the text node that follows a `<span>` label inside an element.
 *
 * SearXNG's detail panel renders fields as `<p class="result-X"><span>Label:</span>value</p>`.
 * Calling `.text()` returns "Label:value"; this helper removes the child `<span>`
 * and returns only the trailing text node.
 *
 * @param $el - Cheerio selection of the container element.
 * @returns Trimmed text after the label span, or `undefined` if empty / non-breaking space.
 */
function labelText($el: ReturnType<ReturnType<typeof cheerio.load>>): string | undefined {
  const val = $el.clone().children("span").remove().end().text().trim();
  return val && val !== "\u00a0" ? val : undefined;
}

/**
 * Strips a locale label prefix from a plain-text string and returns the value.
 *
 * SearXNG renders some video metadata as `"Label: value"` with no child elements
 * (e.g. "Visualizações: 4", "Autor: causaoperaria"). This helper discards
 * everything up to and including the first colon so the result is locale-agnostic.
 *
 * @param text - Raw text content from the element.
 * @returns Trimmed value after the colon, or `undefined` if empty.
 */
function stripLabel(text: string): string | undefined {
  const val = text.replace(/^[^:]+:\s*/, "").trim();
  return val || undefined;
}

// ─── Shared Cheerio type ──────────────────────────────────────────────────────

/** Convenience alias for the Cheerio root returned by `cheerio.load()`. */
type CheerioRoot = ReturnType<typeof cheerio.load>;

// ─── Main results parser ──────────────────────────────────────────────────────

/**
 * Extracts the list of search results from a rendered SearXNG HTML page.
 *
 * Dispatches each `<article class="result">` to the appropriate sub-parser
 * based on its CSS classes:
 *   - `result-images`    → {@link parseImageResult}
 *   - `result-videos`    → {@link parseVideoResult}
 *   - `result-torrent`   → {@link parseFilesResult}
 *   - `result-paper`     → {@link parseScienceResult}
 *   - `result-packages`  → {@link parseITPackageResult}
 *   - `result-map`       → {@link parseMapResult}
 *   - `category-news`    → {@link parseNewsResult}
 *   - `category-social`  → {@link parseSocialMediaResult}
 *   - `category-music`   → {@link parseMusicResult}
 *   - `category-it`      → {@link parseWebResult} (with category forced to "it")
 *   - anything else      → {@link parseWebResult}
 *
 * Tolerates missing optional fields and skips articles whose URL is empty,
 * a fragment, or a JavaScript pseudo-link.
 *
 * @param html - Full HTML string of the rendered results page.
 * @returns Array of parsed {@link SearchResult} objects.
 */
export function parseResults(html: string): SearchResult[] {
  return parseResultsFrom(cheerio.load(html));
}

/**
 * Same as {@link parseResults} but accepts a pre-loaded Cheerio root.
 * Use this when the same HTML is being parsed by multiple functions to avoid
 * redundant `cheerio.load()` calls.
 *
 * @param $ - Pre-loaded Cheerio root.
 * @returns Array of parsed {@link SearchResult} objects.
 */
export function parseResultsFrom($: CheerioRoot): SearchResult[] {
  const results: SearchResult[] = [];

  $("article.result").each((_, el) => {
    const $el = $(el);

    if ($el.hasClass("result-images")) {
      const result = parseImageResult($el);
      if (result) results.push(result);
    } else if ($el.hasClass("result-videos")) {
      const result = parseVideoResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("result-map")) {
      const result = parseMapResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("result-torrent")) {
      const result = parseFilesResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("result-paper")) {
      const result = parseScienceResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("result-packages")) {
      const result = parseITPackageResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("category-news")) {
      const result = parseNewsResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("category-social")) {
      // SearXNG class is "category-social media" — two CSS tokens: category-social + media.
      const result = parseSocialMediaResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("category-music") || $el.attr("data-category") === "music") {
      const result = parseMusicResult($, $el);
      if (result) results.push(result);
    } else if ($el.hasClass("category-it")) {
      // result-default inside category-it: SearXNG omits data-category, so force it.
      const result = parseWebResult($, $el);
      if (result) results.push({ ...result, category: "it" });
    } else {
      const result = parseWebResult($, $el);
      if (result) results.push(result);
    }
  });

  return results;
}

/**
 * Parses a single general web result article.
 *
 * @param $   - Cheerio root.
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseWebResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const $titleLink = $el.find("h3 a").first();
  const url = $titleLink.attr("href")?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title = $titleLink.text().trim();
  const content = $el.find("p.content").first().text().trim() || undefined;
  const category = $el.attr("data-category") || undefined;

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  const scoreAttr = $el.attr("data-score");
  const score = scoreAttr ? parseFloat(scoreAttr) : undefined;
  const thumbnail = $el.find("img.thumbnail").first().attr("src") || undefined;

  return {
    title: title || url,
    url,
    content,
    engines: engines.length > 0 ? engines : undefined,
    score: score !== undefined && !isNaN(score) ? score : undefined,
    category,
    thumbnail,
  };
}

/**
 * Parses a single news result article (`article.result-default.category-news`).
 *
 * News articles share the `result-default` markup with web results but carry
 * two extra elements:
 *   - `time.published_date` — ISO-ish publish timestamp (same mechanism as videos).
 *   - `div.highlight` — rendered as "time-ago | Source Name"; the publisher is
 *     extracted as everything after the last `|` character so it stays
 *     locale-agnostic regardless of how SearXNG formats the time portion.
 *
 * Thumbnails are optional — only present when the news engine supplies an image.
 *
 * @param $   - Cheerio root (needed for engines `.each` callback).
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseNewsResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const $titleLink = $el.find("h3 a").first();
  const url = $titleLink.attr("href")?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title = $titleLink.text().trim();
  const content = $el.find("p.content").first().text().trim() || undefined;

  // Thumbnail is optional — only some news engines supply one.
  const thumbnail =
    $el.find("a.thumbnail_link img.thumbnail").first().attr("src")?.trim() ||
    undefined;

  // Published date: prefer datetime attribute; fall back to visible text.
  const datetimeAttr = $el.find("time.published_date").attr("datetime")?.trim();
  const datetimeText = $el.find("time.published_date").text().trim();
  const publishedDate = datetimeAttr || datetimeText || undefined;

  // Source name: the highlight div renders "time-ago | Publisher".
  // Split on "|" and take the last segment so locale of the time-ago string
  // does not matter.
  const highlightText = $el.find("div.highlight").first().text().trim();
  const source = highlightText.includes("|")
    ? highlightText.split("|").pop()?.trim() || undefined
    : undefined;

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  const scoreAttr = $el.attr("data-score");
  const score = scoreAttr ? parseFloat(scoreAttr) : undefined;

  return {
    title: title || url,
    url,
    content,
    engines: engines.length > 0 ? engines : undefined,
    score: score !== undefined && !isNaN(score) ? score : undefined,
    category: "news",
    thumbnail,
    publishedDate,
    source,
  };
}

/**
 * Parses a single image result article (`article.result-images`).
 *
 * SearXNG image results use a different layout from web results:
 * - The main `<a href>` points to the full-resolution image file.
 * - The source page URL is in the `.result-url a` inside the detail panel.
 * - Metadata (format, file size, engine) are in labelled `<p>` elements
 *   and are extracted with {@link labelText}.
 * - The thumbnail is in `img.image_thumbnail`; some instances lazy-load it
 *   via `data-src` instead of `src`.
 *
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid image URL.
 */
function parseImageResult(
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  // The href on the first <a> is the direct image URL.
  const imageUrl = $el.find("a[rel='noreferrer']").first().attr("href")?.trim();
  if (!imageUrl || imageUrl.startsWith("#") || imageUrl.startsWith("javascript:")) return null;

  // Source page where the image was found — used as the canonical `url`.
  const sourceUrl = $el.find("p.result-url a").first().attr("href")?.trim();
  const url = sourceUrl ?? imageUrl;

  const title = $el.find("span.title").first().text().trim();
  const resolution = $el.find("span.image_resolution").first().text().trim() || undefined;

  // Thumbnail: prefer src, fall back to data-src for lazy-loaded instances.
  const $thumb = $el.find("img.image_thumbnail").first();
  const thumbnail =
    ($thumb.attr("src")?.trim() || $thumb.attr("data-src")?.trim()) || undefined;

  // Detail-panel metadata — label text is stripped by labelText().
  const format = labelText($el.find("p.result-format"));
  const fileSize = labelText($el.find("p.result-filesize"));

  // Engine name from the detail panel (locale-agnostic: strip everything before
  // the colon that the <span> label contains).
  const engineRaw = labelText($el.find("p.result-engine"));
  const engines = engineRaw ? [engineRaw] : undefined;

  // Content from the detail panel (often just the title repeated; skip if so).
  const rawContent = $el.find("p.result-content").first().text().trim();
  const content =
    rawContent && rawContent !== "\u00a0" && rawContent !== title
      ? rawContent
      : undefined;

  return {
    title: title || url,
    url,
    content,
    engines,
    category: "images",
    thumbnail,
    imageUrl,
    resolution,
    format,
    fileSize,
  };
}

/**
 * Parses a single video result article (`article.result-videos`).
 *
 * Duration appears in two places depending on the engine:
 *   - `span.thumbnail_length` inside the thumbnail link (e.g. "1:13:41")
 *   - `div.result_length` below the title (e.g. "Duração: 0:02:12")
 *
 * View count and author are plain-text divs with a locale label prefix
 * (e.g. "Visualizações: 4", "Autor: causaoperaria") — the prefix is stripped
 * with a regex that matches everything up to and including the first colon.
 *
 * @param $   - Cheerio root (needed for engines `.each` callback).
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseVideoResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const url = (
    $el.find("a.url_header").first().attr("href") ??
    $el.find("h3 a").first().attr("href")
  )?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title = $el.find("h3 a").first().text().trim();
  const content = $el.find("p.content").first().text().trim() || undefined;
  const thumbnail = $el.find("a.thumbnail_link img.thumbnail").first().attr("src")?.trim() || undefined;

  // Duration: thumbnail badge takes priority; fall back to the text div.
  const durationBadge = $el.find("span.thumbnail_length").first().text().trim();
  const durationDiv = $el.find("div.result_length").text().trim().replace(/^[^:]+:\s*/, "");
  const duration = durationBadge || durationDiv || undefined;

  // Published date: prefer the datetime attribute; fall back to visible text.
  const datetimeAttr = $el.find("time.published_date").attr("datetime")?.trim();
  const datetimeText = $el.find("time.published_date").text().trim();
  const publishedDate = (datetimeAttr || datetimeText) || undefined;

  const viewCount = stripLabel($el.find("div.result_views").text());
  const author = stripLabel($el.find("div.result_author").text());

  // Embed URL for inline playback (lazy-loaded via data-src).
  const embedUrl = $el.find(".embedded-video iframe").attr("data-src")?.trim() || undefined;

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  return {
    title: title || url,
    url,
    content,
    engines: engines.length > 0 ? engines : undefined,
    category: "videos",
    thumbnail,
    duration,
    publishedDate,
    viewCount,
    author,
    embedUrl,
  };
}

/**
 * Parses a single social media result (`article.result-default.category-social`).
 *
 * SearXNG renders fediverse results (Mastodon users/hashtags, Lemmy communities/posts,
 * PeerTube channels) as standard `result-default` articles but with two extra elements:
 *   - `time.published_date`  — creation or post date
 *   - `div.highlight`        — social metadata (follower counts, votes, community name)
 *
 * The `p.content` may contain HTML-encoded inner markup (e.g. Mastodon bio with
 * hashtag `<a>` links). Those tags are stripped to plain text.
 *
 * Note: SearXNG writes the CSS class as `category-social media` (with a space),
 * which the browser and Cheerio parse as two separate class tokens:
 * `category-social` and `media`. The dispatcher matches on `category-social`.
 *
 * @param $   - Cheerio root.
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseSocialMediaResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const url = (
    $el.find("a.url_header").first().attr("href") ??
    $el.find("h3 a").first().attr("href")
  )?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title = $el.find("h3 a").first().text().trim();

  // Content may contain HTML-encoded markup (Mastodon bios, Lemmy descriptions).
  // Strip any decoded HTML tags to return plain text.
  const rawContent = $el.find("p.content").first().text().trim();
  const content = rawContent
    ? rawContent.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim()
    : undefined;

  const thumbnail =
    $el.find("a.thumbnail_link img.thumbnail").first().attr("src")?.trim() ||
    undefined;

  // Published / created date.
  const datetimeAttr = $el.find("time.published_date").attr("datetime")?.trim();
  const datetimeText = $el.find("time.published_date").text().trim();
  const publishedDate = datetimeAttr || datetimeText || undefined;

  // Social metadata line below the title (locale-dependent, engine-dependent).
  const socialMeta = $el.find("div.highlight").first().text().trim() || undefined;

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  return {
    title: title || url,
    url,
    content,
    engines: engines.length > 0 ? engines : undefined,
    category: "social media",
    thumbnail,
    publishedDate,
    socialMeta,
  };
}

/**
 * Parses a single music result article (`article.result-default.category-music`).
 *
 * Music results (Genius, SoundCloud, Mixcloud) share the `result-default` layout
 * with web results but carry media-specific elements:
 *   - `span.thumbnail_length`  — track duration, e.g. "0:03:31" (inside thumbnail)
 *   - `time.published_date`    — release or upload date
 *   - `div.result_views`       — view/play count with a locale label prefix
 *   - `div.result_author`      — artist or uploader with a locale label prefix
 *   - `.embedded-content iframe[data-src]` — lazy-loaded embed player URL
 *
 * @param $   - Cheerio root.
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseMusicResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const url = (
    $el.find("a.url_header").first().attr("href") ??
    $el.find("h3 a").first().attr("href")
  )?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title     = $el.find("h3 a").first().text().trim();
  const content   = $el.find("p.content").first().text().trim() || undefined;
  const thumbnail = $el.find("a.thumbnail_link img.thumbnail").first().attr("src")?.trim() || undefined;

  // Duration: thumbnail badge takes priority (SoundCloud); fall back to div.result_length (wikicommons.audio).
  const durationBadge = $el.find("span.thumbnail_length").first().text().trim();
  const durationDiv   = $el.find("div.result_length").text().trim().replace(/^[^:]+:\s*/, "");
  const duration      = durationBadge || durationDiv || undefined;

  // Published / upload date.
  const datetimeAttr  = $el.find("time.published_date").attr("datetime")?.trim();
  const datetimeText  = $el.find("time.published_date").text().trim();
  const publishedDate = datetimeAttr || datetimeText || undefined;

  const viewCount = stripLabel($el.find("div.result_views").text());
  const author    = stripLabel($el.find("div.result_author").text());

  // Embed player URL (lazy-loaded; SearXNG sets data-src, not src).
  const embedUrl = $el.find(".embedded-content iframe").attr("data-src")?.trim() || undefined;

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  return {
    title: title || url,
    url,
    content,
    engines: engines.length > 0 ? engines : undefined,
    category: "music",
    thumbnail,
    duration,
    publishedDate,
    viewCount,
    author,
    embedUrl,
  };
}

/**
 * Parses a single IT package result (`article.result-packages.category-it`).
 *
 * SearXNG renders package results (Docker Hub, GitHub, PyPI, npm, crates.io, etc.)
 * with a structured `.attributes` block where each field has a dedicated CSS class:
 *   - `.result_package_name code` — package/repo identifier
 *   - `.result_maintainer`        — maintainer or organisation name
 *   - `.result_pubdate time`      — last-updated timestamp (datetime attr preferred)
 *   - `.result_tags`              — space/comma-separated tag list
 *   - `.result_popularity`        — raw popularity string (pulls, stars, etc.)
 *   - `.result_license`           — SPDX licence name (may contain an `<a>`)
 *
 * The thumbnail is optional — GitHub supplies one via `a.thumbnail_link img.thumbnail`;
 * Docker Hub and most package registries do not.
 *
 * @param $   - Cheerio root.
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseITPackageResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const url = (
    $el.find("a.url_header").first().attr("href") ??
    $el.find("h3 a").first().attr("href")
  )?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title   = $el.find("h3 a").first().text().trim();
  const content = $el.find("p.content").first().text().trim() || undefined;

  // Thumbnail present on GitHub results.
  const thumbnail =
    $el.find("a.thumbnail_link img.thumbnail").first().attr("src")?.trim() ||
    undefined;

  // Structured attributes — each has its own CSS class so no label parsing needed.
  const packageName = $el.find(".result_package_name code").first().text().trim() || undefined;

  const maintainer = $el.find(".result_maintainer span").last().text().trim() || undefined;

  // Updated date: prefer datetime attribute on the inner <time> element.
  const $time = $el.find(".result_pubdate time").first();
  const publishedDate =
    ($time.attr("datetime")?.trim() || $time.text().trim()) || undefined;

  const tags       = $el.find(".result_tags span").last().text().trim() || undefined;
  const popularity = $el.find(".result_popularity span").last().text().trim() || undefined;
  const license    = $el.find(".result_license span").last().text().trim() || undefined;

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  return {
    title: title || url,
    url,
    content,
    engines: engines.length > 0 ? engines : undefined,
    category: "it",
    thumbnail,
    packageName,
    author: maintainer,
    publishedDate,
    tags,
    popularity,
    license,
  };
}

/**
 * Parses a single science/paper result article (`article.result-paper.category-science`).
 *
 * Each paper carries a `.attributes` block with labelled `<div>` rows:
 *   `<div><span>Label:</span><span>Value</span></div>`
 *
 * Labels are locale-dependent (PT/EN/FR/DE), so matching uses lowercase
 * substrings that are stable across translations (e.g. "doi", "issn",
 * "autor"/"author", "jornal"/"journal", "etiqueta"/"tag").
 *
 * @param $   - Cheerio root.
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseScienceResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const url = (
    $el.find("a.url_header").first().attr("href") ??
    $el.find("h3 a").first().attr("href")
  )?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title   = $el.find("h3 a").first().text().trim();
  const content = $el.find("p.content").first().text().trim() || undefined;

  // Build a normalised label→value map from the locale-dependent attributes block.
  const attrs: Record<string, string> = {};
  $el.find(".attributes > div").each((_, div) => {
    const spans = $(div).find("span");
    const label = spans.first().text().trim().replace(/:$/, "").toLowerCase();
    // Prefer text of the last span; for DOI the value is inside an <a> child.
    const value = spans.last().text().trim();
    if (label && value) attrs[label] = value;
  });

  // Locale-agnostic field extraction via substring matching.
  const findAttr = (...keys: string[]): string | undefined => {
    for (const [label, value] of Object.entries(attrs)) {
      if (keys.some((k) => label.includes(k))) return value;
    }
    return undefined;
  };

  const publishedDate = findAttr("data", "date", "publi", "erschein", "fecha");
  const author        = findAttr("autor", "author", "auteur");
  const journal       = findAttr("jornal", "journal", "revue", "zeitschrift", "rivista");
  const tags          = findAttr("etiqueta", "tag", "label", "keyword", "subject", "assunto");
  const doi           = findAttr("doi");
  const issn          = findAttr("issn");

  // PDF link: first <a> inside p.altlink whose text is "PDF" or href ends in .pdf.
  let pdfUrl: string | undefined;
  $el.find("p.altlink a").each((_, a) => {
    const href = $(a).attr("href")?.trim() ?? "";
    const text = $(a).text().trim().toUpperCase();
    if (!pdfUrl && (text === "PDF" || href.toLowerCase().endsWith(".pdf"))) {
      pdfUrl = href;
    }
  });

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  return {
    title: title || url,
    url,
    content,
    engines: engines.length > 0 ? engines : undefined,
    category: "science",
    publishedDate,
    author,
    journal,
    tags,
    doi,
    issn,
    pdfUrl,
  };
}

/**
 * Parses a single files/torrent result article (`article.result-torrent.category-files`).
 *
 * SearXNG renders torrent results with two `<p class="stat">` blocks:
 *   - First block: two `.badge` spans — seeders and leechers counts.
 *     Each badge reads `"<count> <locale-label>"` where count is an integer or "N/A".
 *   - Second block: one `.badge` span — file size like `"237.46MB Tamanho do arquivo"`.
 *     The numeric+unit prefix is extracted with a regex so the locale suffix is ignored.
 *
 * @param $   - Cheerio root.
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseFilesResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const url = (
    $el.find("a.url_header").first().attr("href") ??
    $el.find("h3 a").first().attr("href")
  )?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title = $el.find("h3 a").first().text().trim();

  const magnetLink = $el.find("a.magnetlink").first().attr("href")?.trim() || undefined;

  const datetimeAttr = $el.find("time.published_date").attr("datetime")?.trim();
  const datetimeText = $el.find("time.published_date").text().trim();
  const publishedDate = datetimeAttr || datetimeText || undefined;

  // Extract raw badge text from the first p.stat: [seeders-badge, leechers-badge].
  const statBadges: string[] = [];
  $el.find("p.stat").first().find(".badge").each((_, e) => {
    statBadges.push($(e).text().trim());
  });
  const parseStat = (text: string): number | null => {
    const n = parseInt(text.split(/\s+/)[0], 10);
    return isNaN(n) ? null : n;
  };
  const seeders  = statBadges[0] !== undefined ? parseStat(statBadges[0]) : undefined;
  const leechers = statBadges[1] !== undefined ? parseStat(statBadges[1]) : undefined;

  // File size: match leading number+unit before the locale label.
  let fileSize: string | undefined;
  $el.find("p.stat").last().find(".badge").each((_, e) => {
    const text = $(e).text().trim();
    const match = text.match(/^[\d.,]+\s*[KMGTP]?i?B/i);
    if (match) fileSize = match[0].trim();
  });

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  return {
    title: title || url,
    url,
    engines: engines.length > 0 ? engines : undefined,
    category: "files",
    magnetLink,
    fileSize,
    seeders,
    leechers,
    publishedDate,
  };
}

/**
 * Parses a single map result article (`article.result-map.category-map`).
 *
 * SearXNG renders map results (OpenStreetMap / Photon) with:
 *   - A `<table>` whose rows are `<th>label</th><td>value or link</td>`.
 *     Labels are locale-dependent; values are stored in `mapLinks` keyed by
 *     the raw `<th>` text so callers can look up "website", "Wikipedia", etc.
 *   - An `<a class="searxng_init_map">` element whose data attributes carry
 *     the geospatial metadata:
 *       - `data-map-lat` / `data-map-lon` — centroid coordinates (float strings)
 *       - `data-map-boundingbox` — JSON array `[minLat, maxLat, minLon, maxLon]`
 *
 * @param $   - Cheerio root.
 * @param $el - The `<article>` element.
 * @returns A {@link SearchResult} or `null` if the article has no valid URL.
 */
function parseMapResult(
  $: ReturnType<typeof cheerio.load>,
  $el: ReturnType<ReturnType<typeof cheerio.load>>
): SearchResult | null {
  const url = (
    $el.find("a.url_header").first().attr("href") ??
    $el.find("h3 a").first().attr("href")
  )?.trim();

  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;

  const title     = $el.find("h3 a").first().text().trim();
  const thumbnail = $el.find("a.thumbnail_link img.thumbnail").first().attr("src")?.trim() || undefined;

  // Geospatial metadata from the Leaflet init anchor.
  const $mapAnchor = $el.find("a.searxng_init_map").first();
  const lat = parseFloat($mapAnchor.attr("data-map-lat") ?? "");
  const lon = parseFloat($mapAnchor.attr("data-map-lon") ?? "");
  const latitude  = isNaN(lat) ? undefined : lat;
  const longitude = isNaN(lon) ? undefined : lon;

  let boundingBox: number[] | undefined;
  const bboxRaw = $mapAnchor.attr("data-map-boundingbox");
  if (bboxRaw) {
    try {
      const parsed = JSON.parse(bboxRaw);
      if (Array.isArray(parsed) && parsed.length === 4) boundingBox = parsed as number[];
    } catch {
      // Malformed JSON — skip.
    }
  }

  // Metadata table: collect all label→value pairs.
  const mapLinks: Record<string, string> = {};
  $el.find("table tr").each((_, tr) => {
    const label = $(tr).find("th").text().trim();
    const $td   = $(tr).find("td");
    // Prefer the href of a link inside the cell; fall back to plain text.
    const value = $td.find("a").first().attr("href")?.trim() || $td.text().trim();
    if (label && value) mapLinks[label] = value;
  });

  const engines: string[] = [];
  $el.find(".engines span").each((_, e) => {
    const name = $(e).text().trim();
    if (name) engines.push(name);
  });

  return {
    title: title || url,
    url,
    engines: engines.length > 0 ? engines : undefined,
    category: "map",
    thumbnail,
    latitude,
    longitude,
    boundingBox,
    mapLinks: Object.keys(mapLinks).length > 0 ? mapLinks : undefined,
  };
}

// ─── Extras parser ────────────────────────────────────────────────────────────

/** Combined output of the extras parser. */
export interface ParsedExtras {
  answers: Answer[];
  infobox: Infobox | null;
  suggestions: string[];
}

/**
 * Extracts supplementary content from the SearXNG sidebar and answer panels:
 * direct answers (`#answers`), the entity infobox (`#infoboxes`), and related
 * search suggestions (`#suggestions`).
 *
 * @param html - Full HTML string of the rendered results page.
 * @returns A {@link ParsedExtras} object with answers, infobox, and suggestions.
 */
export function parseExtras(html: string): ParsedExtras {
  return parseExtrasFrom(cheerio.load(html));
}

/**
 * Same as {@link parseExtras} but accepts a pre-loaded Cheerio root.
 * Use this when the same HTML is being parsed by multiple functions to avoid
 * redundant `cheerio.load()` calls.
 *
 * @param $ - Pre-loaded Cheerio root.
 * @returns A {@link ParsedExtras} object with answers, infobox, and suggestions.
 */
export function parseExtrasFrom($: CheerioRoot): ParsedExtras {
  const answers: Answer[] = [];
  $("#answers .answer").each((_, el) => {
    const $el = $(el);
    const text = $el.find("span").first().text().trim();
    const url = $el.find("a.answer-url").attr("href")?.trim();
    if (text) answers.push({ text, url });
  });

  let infobox: Infobox | null = null;
  const $box = $("#infoboxes aside.infobox").first();
  if ($box.length) {
    const title = $box.find("h2.title").text().trim();
    const description = $box.find("p").first().text().trim();
    const imageUrl = $box.find("img").first().attr("src")?.trim();
    const wikiUrl = $box.find(".urls a").first().attr("href")?.trim();
    if (title) infobox = { title, description, imageUrl, wikiUrl };
  }

  const suggestions: string[] = [];
  $("#suggestions input.suggestion").each((_, el) => {
    const val = $(el).attr("value")?.trim();
    if (val) suggestions.push(val);
  });

  return { answers, infobox, suggestions };
}

// ─── Pagination parser ────────────────────────────────────────────────────────

/** Pagination metadata extracted from a SearXNG results page. */
export interface ParsedPagination {
  /** Current page number (1-indexed), detected from the active page button. */
  pageno: number;
  /** Whether the page contains a "previous page" navigation form. */
  hasPrevPage: boolean;
  /** Whether the page contains a "next page" navigation form. */
  hasNextPage: boolean;
  /**
   * Highest page number visible in the numbered pagination widget, or `null`
   * when the widget is absent. This is an approximation — SearXNG renders a
   * sliding window of roughly 10 page links, not the true result count.
   */
  totalPages: number | null;
  /**
   * Estimated total result count reported by the instance via `#result_count`,
   * or `null` when the element is absent. The value is locale-independent —
   * both `.` and `,` thousand-separators are stripped before parsing.
   */
  estimatedResults: number | null;
}

/**
 * Extracts pagination metadata from a rendered SearXNG results page.
 *
 * SearXNG's simple theme renders navigation as HTML forms:
 *   - `form.next_page`      — navigates forward one page
 *   - `form.previous_page`  — navigates back one page
 *   - `div.numbered_pagination form.page_number` — numbered page links;
 *     the active page has `input.page_number_current` instead of a submit input.
 *
 * @param html - Full HTML string of the rendered results page.
 * @returns A {@link ParsedPagination} object with current page and navigation state.
 */
export function parsePagination(html: string): ParsedPagination {
  return parsePaginationFrom(cheerio.load(html));
}

/**
 * Same as {@link parsePagination} but accepts a pre-loaded Cheerio root.
 * Use this when the same HTML is being parsed by multiple functions to avoid
 * redundant `cheerio.load()` calls.
 *
 * @param $ - Pre-loaded Cheerio root.
 * @returns A {@link ParsedPagination} object with current page and navigation state.
 */
export function parsePaginationFrom($: CheerioRoot): ParsedPagination {
  // Current page: the non-submit "current" button in the numbered pagination.
  let pageno = 1;
  const currentInput = $("input.page_number_current").first();
  if (currentInput.length) {
    const val = parseInt(currentInput.attr("value") ?? "1", 10);
    if (!isNaN(val) && val > 0) pageno = val;
  }

  // Prev / next presence: SearXNG renders dedicated form elements for these.
  const hasPrevPage = $("form.previous_page").length > 0;
  const hasNextPage = $("form.next_page").length > 0;

  // Highest page number visible in the numbered pagination widget.
  let totalPages: number | null = null;
  const pageValues: number[] = [];
  $(".numbered_pagination input[name='pageno']").each((_, el) => {
    const val = parseInt($(el).attr("value") ?? "0", 10);
    if (!isNaN(val) && val > 0) pageValues.push(val);
  });
  if (pageValues.length > 0) totalPages = Math.max(...pageValues);

  // Estimated result count from #result_count (e.g. "Número de resultados: 76.100").
  // Strip locale-specific thousand separators (both "." and ",") before parsing.
  let estimatedResults: number | null = null;
  const countText = $("#result_count").text();
  if (countText) {
    const match = countText.match(/[\d.,]+/);
    if (match) {
      const digits = match[0].replace(/[.,]/g, "");
      const parsed = parseInt(digits, 10);
      if (!isNaN(parsed) && parsed > 0) estimatedResults = parsed;
    }
  }

  return { pageno, hasPrevPage, hasNextPage, totalPages, estimatedResults };
}

// ─── Combined parser ──────────────────────────────────────────────────────────

/** Combined output of all three parsers run on the same HTML. */
export interface ParsedAll {
  results: SearchResult[];
  extras: ParsedExtras;
  pagination: ParsedPagination;
  /** The Cheerio root — callers may reuse it for additional queries. */
  $: CheerioRoot;
}

/**
 * Parses results, extras, and pagination from a single `cheerio.load()` call.
 *
 * Use this in the hot path (e.g. `searchOneInstance`) instead of calling
 * `parseResults`, `parseExtras`, and `parsePagination` separately, which would
 * each rebuild the DOM tree from scratch.
 *
 * @param html - Full HTML string of the rendered results page.
 * @returns A {@link ParsedAll} object containing all parsed data and the Cheerio root.
 */
export function parseAll(html: string): ParsedAll {
  const $ = cheerio.load(html);
  return {
    results: parseResultsFrom($),
    extras: parseExtrasFrom($),
    pagination: parsePaginationFrom($),
    $,
  };
}

// ─── Block detection ──────────────────────────────────────────────────────────

/** Reason why a SearXNG instance rejected or challenged the request. */
export type BlockReason =
  | "captcha"
  | "rate_limit"
  | "access_denied"
  | "cloudflare"
  | null;

/**
 * Inspects an HTTP status code and the rendered HTML for well-known block
 * patterns (CAPTCHA pages, Cloudflare challenges, rate-limit banners).
 *
 * Returns `null` when no block is detected, allowing normal result parsing.
 *
 * @param html       - Full HTML string of the response body.
 * @param statusCode - HTTP status code of the navigation response.
 * @returns A {@link BlockReason} string, or `null` if the page looks clean.
 */
export function detectBlock(html: string, statusCode: number): BlockReason {
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 403) return "access_denied";

  // Case-insensitive regex avoids allocating a lowercase copy of the full HTML.
  if (
    /cf-browser-verification/i.test(html) ||
    (/cloudflare/i.test(html) && /checking your browser/i.test(html))
  )
    return "cloudflare";

  if (
    /captcha/i.test(html) ||
    /recaptcha/i.test(html) ||
    /i am not a robot/i.test(html) ||
    /are you human/i.test(html)
  )
    return "captcha";

  if (/too many requests/i.test(html) || /rate limit/i.test(html))
    return "rate_limit";

  if (/access denied/i.test(html) || /403 forbidden/i.test(html))
    return "access_denied";

  return null;
}
