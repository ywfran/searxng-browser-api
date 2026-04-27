/**
 * @file filter.ts
 * Result filtering and quality scoring.
 *
 * Filtering is category-aware: the base blocklist applies to all categories,
 * and each category can add its own domain/pattern rules. This lets the system
 * block YouTube homepage links for general searches while still allowing YouTube
 * video pages as valid results in the videos category.
 *
 * Scoring overview:
 *   - SemanticScore   : title-weighted keyword + phrase matching, blended best×avg
 *   - QualityScore    : blocklist pass rate × keyword coverage × domain diversity
 *   - LanguageScore   : detects query script/language, blocks mismatched non-Latin results
 */

import fs from "node:fs";
import path from "node:path";
import { SearchResult } from "../types.js";

// ─── Blocklist schema ─────────────────────────────────────────────────────────

interface DomainPatternRules {
  domains: string[];
  patterns: string[];
}

interface Blocklist extends DomainPatternRules {
  categoryRules?: Record<string, DomainPatternRules>;
}

// ─── Language detection ───────────────────────────────────────────────────────

/**
 * Script / language family detected from a string.
 *
 * Used to decide whether to filter foreign-script results:
 * - "latin"   : standard Latin alphabet (EN, PT, ES, FR, DE, IT, …)
 * - "cjk"     : Chinese / Japanese / Korean
 * - "cyrillic": Russian, Ukrainian, Bulgarian, …
 * - "arabic"  : Arabic, Farsi, Urdu
 * - "other"   : Hebrew, Greek, Thai, Devanagari, etc.
 */
type Script = "latin" | "cjk" | "cyrillic" | "arabic" | "other";


const RE_CJK      = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
const RE_CYRILLIC = /[\u0400-\u04ff]/;
const RE_ARABIC   = /[\u0600-\u06ff]/;
const RE_OTHER_SCRIPT = /[\u0370-\u03ff\u0590-\u05ff\u0e00-\u0e7f\u0900-\u097f]/;

function detectScript(text: string): Script {
  if (RE_CJK.test(text))      return "cjk";
  if (RE_CYRILLIC.test(text)) return "cyrillic";
  if (RE_ARABIC.test(text))   return "arabic";
  if (RE_OTHER_SCRIPT.test(text)) return "other";
  return "latin";
}

// Single compiled regex is faster than iterating over a Set for every result.
const LANGUAGE_INTENT_RE = new RegExp(
  "\\b(" +
  [
    // PT / ES / IT
    "coreano?","japones[ae]?","chines[ae]?","traducao","traduccion","tradurre",
    "dicionario","diccionario","dizionario","significado","alfabeto","aprender",
    "traduzir","traducir","idioma","lingua","lengua",
    // EN
    "translate","translation","dictionary","meaning","alphabet","learn","speak",
    "grammar","korean","japanese","chinese","language","script","multilingual",
    // FR
    "traduire","traduction","dictionnaire","signification","apprendre",
    // DE
    "ubersetzen","ubersetzung","worterbuch","bedeutung","lernen","japanisch","koreanisch","chinesisch",
  ].join("|") +
  ")\\b",
  "i"
);

/**
 * Returns true when the query expresses intent to see or learn about
 * foreign-language content (translation, learning a language, etc.).
 */
function isLanguageIntent(query: string): boolean {
  if (detectScript(query) !== "latin") return true; // User typed in a non-Latin script

  const norm = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return LANGUAGE_INTENT_RE.test(norm);
}

// ─── Keyword extraction ───────────────────────────────────────────────────────

/**
 * Extended multilingual stopwords. Kept as a Set for O(1) lookup.
 * Covers EN, PT, ES, FR, DE, IT common function words.
 */
const STOPWORDS = new Set([
  // EN
  "the","and","for","with","how","what","why","when","where","who",
  "are","was","has","have","had","its","not","but","from","this","that",
  "will","can","all","any","one","into","about","more","also","just",
  // PT
  "que","uma","para","com","por","dos","das","nos","nas","seu","sua",
  "como","mais","isso","este","esta","esse","essa","ser","ter","ele","ela",
  "mas","sem","num","nao","sim","foi","por","ate","pois","cada",
  // ES
  "los","las","del","una","con","por","que","como","sus","para","esta",
  "pero","hay","ser","todo","cuando","estos","estas","entonces",
  // FR
  "les","des","une","pour","dans","sur","avec","qui","que","son","ses",
  "est","ont","pas","mais","plus","tout","bien","aussi","donc",
  // DE
  "die","der","das","und","ist","mit","bei","von","des","ein","eine",
  "nicht","auch","wird","sich","als","fur","uber","nach",
  // IT
  "del","dei","nel","per","con","che","nel","una","gli","sono","non",
  "come","anche","questo","questa","sono","fare","anno",
  // Generic
  "http","https","www","com","org","net","edu","gov",
]);

/**
 * Extracts meaningful keywords and bigrams from a query.
 *
 * Returns single tokens AND adjacent pairs (bigrams) so that compound terms
 * like "artificial intelligence" score as a phrase bonus.
 *
 * @param query - Raw search query.
 * @returns Object with `keywords` (single tokens) and `phrases` (bigrams).
 */
function extractTerms(query: string): { keywords: string[]; phrases: string[] } {
  const tokens = query
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

  const phrases: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
  }

  return { keywords: tokens, phrases };
}

// ─── Login / utility page detection ──────────────────────────────────────────

/**
 * Multilingual titles that indicate non-content utility pages.
 * EN / PT / ES / FR / DE / IT patterns.
 */
const UTILITY_TITLE_RE = new RegExp(
  "^(" +
  // EN
  "login|log\\s*in|sign\\s*in|sign\\s*up|register|create\\s*account|forgot\\s*password|" +
  "reset\\s*password|subscribe|download\\s+(app|now)|install\\s+\\S+|get\\s+\\S+\\s+(app|free)|" +
  // PT
  "entrar|fazer\\s*login|cadastro|criar\\s*conta|inscrever|baixar\\s+(app|agora|gratis)|" +
  "instalar|assinar|aceder|redefinir\\s*senha|esqueci\\s*(a\\s*)?senha|minha\\s*conta|" +
  // ES
  "iniciar\\s*sesi[oó]n|registr[ao]rse|crear\\s*cuenta|descargar|instalar\\s+\\S+|" +
  "suscribirse|acceder|restablecer\\s*contrase[nñ]a|" +
  // FR
  "connexion|s['']inscrire|cr[eé]er\\s*(un\\s*)?compte|t[eé]l[eé]charger|" +
  "installer|s['']abonner|mot\\s*de\\s*passe\\s*oubli[eé]|" +
  // DE
  "anmelden|registrieren|konto\\s*erstellen|herunterladen|installieren|passwort\\s*vergessen" +
  ")\\b",
  "i"
);

/**
 * Query keywords that indicate the user is intentionally looking for
 * login, registration, or account-related pages (in any supported language).
 * When matched, utility pages are NOT penalised in quality scoring.
 */
const UTILITY_INTENT_RE = new RegExp(
  "\\b(" +
  // EN
  "login|log\\s*in|sign\\s*in|sign\\s*up|register|create\\s*account|" +
  "reset\\s*password|forgot\\s*password|account|subscription|" +
  // PT
  "entrar|login|cadastro|criar\\s*conta|minha\\s*conta|esqueci\\s*senha|" +
  "redefinir\\s*senha|inscri[cç][aã]o|assinar|baixar\\s*(app|aplicativo)|" +
  // ES
  "iniciar\\s*sesi[oó]n|registro|registrarse|crear\\s*cuenta|contrase[nñ]a|" +
  "descargar\\s*(app|aplicaci[oó]n)|suscripci[oó]n|" +
  // FR
  "connexion|s['']inscrire|cr[eé]er\\s*compte|mot\\s*de\\s*passe|t[eé]l[eé]charger|" +
  // DE
  "anmelden|registrieren|konto\\s*erstellen|passwort|herunterladen" +
  ")\\b",
  "i"
);

function isUtilityPage(result: SearchResult): boolean {
  const title = result.title.trim();
  return UTILITY_TITLE_RE.test(title) || title.length < 5 || title === result.url;
}

function hasUtilityIntent(query: string): boolean {
  return UTILITY_INTENT_RE.test(query);
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/**
 * Levenshtein-based similarity: returns true when edit distance ≤ floor(len/4).
 * More accurate than character-set overlap for detecting typos in technical terms.
 * Fast for short words (≤20 chars) — longer words skip fuzzy matching.
 */
function isSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 3) return false;
  if (a.length > 20 || b.length > 20) return false;

  // Short-circuit: if strings share a long common prefix, they're likely similar.
  const prefixLen = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < prefixLen && a[shared] === b[shared]) shared++;
  if (shared >= Math.ceil(prefixLen * 0.75)) return true;

  // Compute edit distance via DP row.
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = a[i - 1] === b[j - 1]
        ? prevDiag
        : 1 + Math.min(prevDiag, prev[j], prev[j - 1]);
      prevDiag = temp;
    }
  }

  const maxDist = Math.floor(Math.max(a.length, b.length) / 4);
  return prev[b.length] <= Math.max(1, maxDist);
}

const GENERIC_TLDS = new Set(["com","net","org","edu","gov","io","co","br","pt","uk","de","fr","es","it"]);

/**
 * Domain diversity multiplier in [0.5, 1.0].
 *
 * Penalises result sets dominated by a single eTLD+1 domain — a sign that
 * one engine is recycling the same site. Skips the penalty when the query
 * itself names the dominant domain (e.g. "g1 notícias" → g1.globo.com is fine,
 * "hotmart suporte" → hotmart.com is fine).
 *
 * @param results - Usable result list (already filtered and utility-stripped).
 * @param query   - Original search query for targeted-domain detection.
 */
function domainDiversityMultiplier(results: SearchResult[], query: string): number {
  if (results.length <= 1) return 1.0;

  const queryNorm = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const domainCounts = new Map<string, number>();
  for (const r of results) {
    try {
      // Strip www and subdomains down to eTLD+1.
      const parts = new URL(r.url).hostname.toLowerCase().replace(/^www\./, "").split(".");
      const etld1 = parts.slice(-2).join(".");
      domainCounts.set(etld1, (domainCounts.get(etld1) ?? 0) + 1);
    } catch {
      // Skip unparseable URLs.
    }
  }

  let maxCount = 0;
  let dominantDomain = "";
  for (const [domain, count] of domainCounts) {
    if (count > maxCount) { maxCount = count; dominantDomain = domain; }
  }

  const dominance = maxCount / results.length;
  if (dominance <= 0.5) return 1.0; // No significant concentration — no penalty.

  // Check whether the user was deliberately targeting this domain.
  // Split on non-alphanumeric so "g1.globo.com" → ["g1", "globo", "com"].
  // A part with length ≥ 2 that appears in the query signals intent.
  const domainParts = dominantDomain.split(/[^a-z0-9]+/).filter((p) => p.length >= 2 && !GENERIC_TLDS.has(p));
  const userTargeted = domainParts.some((p) => queryNorm.includes(p));

  if (userTargeted) return 1.0; // User intended this domain — no diversity penalty.

  // Linear penalty: 50% dominance → 1.0, 100% dominance → 0.75.
  // Using 0.75 floor (was 0.5) — diversity matters but shouldn't kill a good instance.
  return 1.0 - dominance * 0.25;
}

// ─── ResultFilter ─────────────────────────────────────────────────────────────

/**
 * Handles filtering and quality/semantic scoring of search results.
 */
export class ResultFilter {
  private blocklist: Blocklist;

  constructor() {
    this.blocklist = this.loadBlocklist();
  }

  private loadBlocklist(): Blocklist {
    try {
      const filePath = path.join(process.cwd(), "data", "blocklist.json");
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Blocklist;
      }
    } catch {
      // Blocklist unavailable — proceed with empty rules.
    }
    return { domains: [], patterns: [] };
  }

  /**
   * Returns the merged effective rules for a given category.
   * Base rules always apply; category-specific rules are additive.
   */
  private effectiveRules(category: string): DomainPatternRules {
    const catRules = this.blocklist.categoryRules?.[category];
    return {
      domains: [...this.blocklist.domains, ...(catRules?.domains ?? [])],
      patterns: [...this.blocklist.patterns, ...(catRules?.patterns ?? [])],
    };
  }

  /**
   * Splits results into filtered (allowed) and denied (blocked) groups.
   *
   * @param results  - Raw result list from a candidate instance.
   * @param query    - Search query for entity-aware relaxation and script detection.
   * @param category - SearXNG category; determines which additional rules apply.
   */
  apply(
    results: SearchResult[],
    query = "",
    category = "general"
  ): { filtered: SearchResult[]; denied: SearchResult[] } {
    const filtered: SearchResult[] = [];
    const denied: SearchResult[] = [];

    const linguistic = isLanguageIntent(query);
    const queryScript = detectScript(query);

    for (const result of results) {
      if (this.isBlocked(result, linguistic, queryScript, query, category)) {
        denied.push(result);
      } else {
        filtered.push(result);
      }
    }

    return { filtered, denied };
  }

  /**
   * Quality score (0.0–1.0) combining three signals:
   *
   *  1. **Blocklist pass rate** — fraction of results not blocked.
   *  2. **Keyword coverage** — fraction of passing results mentioning ≥1 query keyword.
   *     Catches "engine contamination" (e.g. Bing injecting school portals for AI queries).
   *  3. **Domain diversity** — penalises result sets dominated by a single domain.
   *
   * Utility pages (login, register, etc.) are counted as non-passing even when they
   * clear the domain/pattern blocklist.
   *
   * @param results  - Raw result list.
   * @param query    - Original search query.
   * @param category - SearXNG category for per-category filtering.
   */
  calculateQuality(results: SearchResult[], query = "", category = "general"): number {
    if (results.length === 0) return 1.0;

    const { filtered } = this.apply(results, query, category);

    // Utility-page penalty: treat login/register/download-app pages as non-passing,
    // UNLESS the query itself expresses intent to find such pages (e.g. "como fazer
    // login hotmart", "register github", "criar conta netflix").
    const utilityIntent = hasUtilityIntent(query);
    const usable = filtered.filter((r) => utilityIntent || !isUtilityPage(r));
    const blocklistScore = usable.length / results.length;

    const { keywords } = extractTerms(query);
    let keywordCoverage = 1.0;
    if (keywords.length > 0 && usable.length > 0) {
      const relevantCount = usable.filter((r) => {
        const text = `${r.title} ${r.content ?? ""}`.toLowerCase();
        return keywords.some((kw) => text.includes(kw));
      }).length;
      keywordCoverage = relevantCount / usable.length;
    }

    // Domain diversity: skips penalty when user targeted the dominant domain.
    const diversityMult = domainDiversityMultiplier(usable, query);

    // Weights: 50% blocklist+utility, 30% keyword coverage, 20% diversity.
    return blocklistScore * (0.5 + 0.3 * keywordCoverage + 0.2 * diversityMult);
  }

  /**
   * Semantic relevance score (0.0–1.0).
   *
   * Scoring per result (contributions summed then normalised):
   *   - Phrase match in title    : +4.0 per phrase
   *   - Exact keyword in title   : +3.0 per keyword
   *   - Exact keyword in content : +1.0 per keyword
   *   - Fuzzy keyword in title   : +2.0 (typo tolerance)
   *   - Fuzzy keyword in content : +0.6
   *   - Engine consensus bonus   : +0.5 if confirmed by ≥2 engines
   *
   * Final blend: 70% best-result score + 30% average score.
   * Pure-max (old approach) let junk from one engine hide behind excellent
   * results from another; the 30% average component exposes that.
   *
   * @param results - Candidate's result list.
   * @param query   - Original search query.
   */
  calculateSemanticScore(results: SearchResult[], query: string): number {
    if (results.length === 0) return 0;

    const { keywords, phrases } = extractTerms(query);
    if (keywords.length === 0) return 0.5;

    // Max score a single result can achieve (used for normalisation).
    const phraseMaxPts   = phrases.length * 4.0;
    const keywordMaxPts  = keywords.length * 3.0;
    const consensusMax   = 0.5;
    const maxPerResult   = phraseMaxPts + keywordMaxPts + consensusMax;

    let bestScore  = 0;
    let totalScore = 0;

    for (const result of results) {
      const titleLower   = result.title.toLowerCase();
      const contentLower = (result.content ?? "").toLowerCase();
      const titleWords   = titleLower.split(/[^a-z0-9]+/);
      const contentWords = contentLower.split(/[^a-z0-9]+/);
      let pts = 0;

      // Phrase matching (bigrams) — titles only, very high signal.
      for (const phrase of phrases) {
        if (titleLower.includes(phrase)) pts += 4.0;
      }

      // Keyword matching with title vs content weighting.
      for (const kw of keywords) {
        if (titleLower.includes(kw)) {
          pts += 3.0;
        } else if (contentLower.includes(kw)) {
          pts += 1.0;
        } else {
          // Fuzzy fallback: title first (higher weight), then content.
          if (titleWords.some((w) => w.length >= 3 && isSimilar(kw, w))) {
            pts += 2.0;
          } else if (contentWords.some((w) => w.length >= 3 && isSimilar(kw, w))) {
            pts += 0.6;
          }
        }
      }

      // Engine consensus bonus: result confirmed by ≥2 independent engines.
      if ((result.engines?.length ?? 0) >= 2) pts += 0.5;

      const normalised = Math.min(1.0, pts / maxPerResult);
      if (normalised > bestScore) bestScore = normalised;
      totalScore += normalised;
    }

    const avgScore = totalScore / results.length;

    // 70% best + 30% avg: best drives the floor, avg exposes contamination.
    return Math.min(1.0, bestScore * 0.7 + avgScore * 0.3);
  }

  /**
   * Evaluates candidates and returns the one with the highest combined score,
   * provided it clears the semantic floor (0.4).
   *
   * @param candidates - Instances that returned ≥1 result.
   * @param query      - Original search query.
   * @param category   - SearXNG category for scoring.
   */
  pickBest<T extends { results: SearchResult[]; instanceUrl: string }>(
    candidates: T[],
    query: string,
    category = "general"
  ): T | null {
    if (candidates.length === 0) return null;

    let best: T | null = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      const quality  = this.calculateQuality(candidate.results, query, category);
      const semantic = this.calculateSemanticScore(candidate.results, query);

      if (semantic < 0.4) continue;

      // Volume bonus: more results (up to ~10) = more authority signal.
      const volumeBonus = Math.min(0.15, candidate.results.length * 0.015);
      const totalScore  = quality * 0.4 + semantic * 0.6 + volumeBonus;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        best = candidate;
      }
    }

    return best;
  }

  // ─── Private: isBlocked ────────────────────────────────────────────────────

  private isBlocked(
    result: SearchResult,
    linguistic: boolean,
    queryScript: Script,
    query: string,
    category: string
  ): boolean {
    const urlLower   = result.url.toLowerCase();
    const queryLower = query.toLowerCase();
    const rules      = this.effectiveRules(category);

    // 1. Domain blocklist with entity-aware relaxation.
    try {
      const hostname = new URL(result.url).hostname.toLowerCase();
      const matched  = rules.domains.find(
        (d) => hostname === d.toLowerCase() || hostname.endsWith("." + d.toLowerCase())
      );

      if (matched) {
        // Extract the identifying word from the blocked domain (e.g. "youtube" from "youtube.com").
        const entity = matched
          .split(".")
          .find((p) => p.length >= 2 && !["support","help","com","org","net","edu","gov"].includes(p));

        const isTargeted     = !!entity && queryLower.includes(entity);
        const hostnameInQuery = hostname
          .replace(/^www\./, "")
          .split(/[^a-z]+/)
          .some((part) => part.length > 4 && queryLower.includes(part));

        if (!isTargeted && !hostnameInQuery) return true;
      }
    } catch {
      // Malformed URL: fall through to pattern check.
    }

    // 2. URL path pattern blocklist.
    if (rules.patterns.some((p) => urlLower.includes(p.toLowerCase()))) return true;

    // 3. Foreign-script filter.
    //    Allow if: user's query expresses language intent, OR the result's script
    //    matches the query's own script (e.g. a CJK query → CJK results allowed).
    if (!linguistic) {
      const resultScript = detectScript(result.title);
      if (resultScript !== "latin" && resultScript !== queryScript) return true;
    }

    return false;
  }
}

export const resultFilter = new ResultFilter();
