import { describe, it, expect } from "vitest";
import {
  parseExtras,
  parsePagination,
  parseAll,
  detectBlock,
} from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

// ─── parseExtras ─────────────────────────────────────────────────────────────

describe("parseExtras", () => {
  it("extracts answers with and without source URL", () => {
    const html = page(`
      <div id="answers">
        <div class="answer">
          <span>42</span>
          <a class="answer-url" href="https://source.example.com">source</a>
        </div>
        <div class="answer">
          <span>Paris</span>
        </div>
      </div>
    `);
    const { answers } = parseExtras(html);
    expect(answers).toHaveLength(2);
    expect(answers[0].text).toBe("42");
    expect(answers[0].url).toBe("https://source.example.com");
    expect(answers[1].text).toBe("Paris");
    expect(answers[1].url).toBeUndefined();
  });

  it("extracts the infobox title, description, imageUrl, and wikiUrl", () => {
    const html = page(`
      <div id="infoboxes">
        <aside class="infobox">
          <h2 class="title">Paris</h2>
          <p>Capital city of France.</p>
          <img src="https://proxy.instance/paris.jpg">
          <div class="urls"><a href="https://en.wikipedia.org/wiki/Paris">Wikipedia</a></div>
        </aside>
      </div>
    `);
    const { infobox } = parseExtras(html);
    expect(infobox?.title).toBe("Paris");
    expect(infobox?.description).toBe("Capital city of France.");
    expect(infobox?.imageUrl).toBe("https://proxy.instance/paris.jpg");
    expect(infobox?.wikiUrl).toBe("https://en.wikipedia.org/wiki/Paris");
  });

  it("extracts suggestions", () => {
    const html = page(`
      <div id="suggestions">
        <input class="suggestion" value="paris france">
        <input class="suggestion" value="paris hilton">
      </div>
    `);
    const { suggestions } = parseExtras(html);
    expect(suggestions).toEqual(["paris france", "paris hilton"]);
  });

  it("returns empty arrays and null infobox when all sections are absent", () => {
    const { answers, infobox, suggestions } = parseExtras("<html><body></body></html>");
    expect(answers).toHaveLength(0);
    expect(infobox).toBeNull();
    expect(suggestions).toHaveLength(0);
  });
});

// ─── parsePagination ──────────────────────────────────────────────────────────

describe("parsePagination", () => {
  it("extracts pageno, prev/next presence, totalPages, and estimatedResults", () => {
    const html = page(`
      <div id="result_count">Number of results: 76,100</div>
      <div class="numbered_pagination">
        <form class="page_number"><input name="pageno" value="1"></form>
        <form class="page_number">
          <input class="page_number_current" name="pageno" value="3">
        </form>
        <form class="page_number"><input name="pageno" value="10"></form>
      </div>
      <form class="previous_page"></form>
      <form class="next_page"></form>
    `);
    const p = parsePagination(html);
    expect(p.pageno).toBe(3);
    expect(p.hasPrevPage).toBe(true);
    expect(p.hasNextPage).toBe(true);
    expect(p.totalPages).toBe(10);
    expect(p.estimatedResults).toBe(76100);
  });

  it("handles dot thousand-separators (PT locale)", () => {
    const html = page(`<div id="result_count">Número de resultados: 76.100</div>`);
    const { estimatedResults } = parsePagination(html);
    expect(estimatedResults).toBe(76100);
  });

  it("returns page 1 and false navigation flags when no pagination is present", () => {
    const p = parsePagination("<html><body></body></html>");
    expect(p.pageno).toBe(1);
    expect(p.hasPrevPage).toBe(false);
    expect(p.hasNextPage).toBe(false);
    expect(p.totalPages).toBeNull();
    expect(p.estimatedResults).toBeNull();
  });
});

// ─── detectBlock ─────────────────────────────────────────────────────────────

describe("detectBlock", () => {
  it("returns rate_limit for HTTP 429", () => {
    expect(detectBlock("<html></html>", 429)).toBe("rate_limit");
  });

  it("returns access_denied for HTTP 403", () => {
    expect(detectBlock("<html></html>", 403)).toBe("access_denied");
  });

  it("detects Cloudflare by cf-browser-verification marker", () => {
    expect(detectBlock("<html>cf-browser-verification</html>", 200)).toBe("cloudflare");
  });

  it("detects Cloudflare by combined cloudflare + checking your browser keywords", () => {
    expect(
      detectBlock("Checking your browser... Powered by Cloudflare", 200)
    ).toBe("cloudflare");
  });

  it("detects CAPTCHA by recaptcha keyword", () => {
    expect(detectBlock("<html>please complete reCAPTCHA</html>", 200)).toBe("captcha");
  });

  it("detects CAPTCHA by 'i am not a robot' phrase", () => {
    expect(detectBlock("<html>I am not a robot</html>", 200)).toBe("captcha");
  });

  it("detects CAPTCHA by 'are you human' phrase", () => {
    expect(detectBlock("<html>Are you human?</html>", 200)).toBe("captcha");
  });

  it("detects rate limit by 'too many requests' text", () => {
    expect(detectBlock("<html>Too Many Requests</html>", 200)).toBe("rate_limit");
  });

  it("detects access denied by '403 Forbidden' text in body", () => {
    expect(detectBlock("<html>403 Forbidden</html>", 200)).toBe("access_denied");
  });

  it("returns null for a clean results page", () => {
    expect(
      detectBlock("<html><body><div id='results'><article></article></div></body></html>", 200)
    ).toBeNull();
  });
});

// ─── parseAll ────────────────────────────────────────────────────────────────

describe("parseAll", () => {
  it("returns results, extras, and pagination from a single parse pass", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="https://example.com">Result</a></h3>
      </article>
      <div id="suggestions">
        <input class="suggestion" value="example query">
      </div>
      <form class="next_page"></form>
    `);
    const { results, extras, pagination } = parseAll(html);
    expect(results).toHaveLength(1);
    expect(extras.suggestions).toEqual(["example query"]);
    expect(pagination.hasNextPage).toBe(true);
  });

  it("exposes the Cheerio root for additional queries", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="https://example.com">Result</a></h3>
      </article>
    `);
    const { $ } = parseAll(html);
    expect($("article.result").length).toBe(1);
  });
});
