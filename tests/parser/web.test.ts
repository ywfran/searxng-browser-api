import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — web (result-default)", () => {
  it("extracts url, title, content, engines, score, and category", () => {
    const html = page(`
      <article class="result result-default" data-category="general" data-score="0.85">
        <h3><a href="https://example.com/page">Page Title</a></h3>
        <p class="content">Snippet text here.</p>
        <div class="engines"><span>duckduckgo</span><span>brave</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.url).toBe("https://example.com/page");
    expect(r.title).toBe("Page Title");
    expect(r.content).toBe("Snippet text here.");
    expect(r.engines).toEqual(["duckduckgo", "brave"]);
    expect(r.score).toBe(0.85);
    expect(r.category).toBe("general");
  });

  it("falls back to url as title when h3 text is empty", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="https://example.com/page"></a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.title).toBe("https://example.com/page");
  });

  it("extracts thumbnail from img.thumbnail", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="https://example.com">Title</a></h3>
        <img class="thumbnail" src="https://cdn.example.com/thumb.jpg">
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.thumbnail).toBe("https://cdn.example.com/thumb.jpg");
  });

  it("returns undefined for optional fields when absent", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="https://example.com">Title</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.content).toBeUndefined();
    expect(r.engines).toBeUndefined();
    expect(r.score).toBeUndefined();
    expect(r.category).toBeUndefined();
    expect(r.thumbnail).toBeUndefined();
  });

  it("skips articles with no href", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a>No href</a></h3>
      </article>
    `);
    expect(parseResults(html)).toHaveLength(0);
  });

  it("skips articles with a fragment href", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="#section">Fragment</a></h3>
      </article>
    `);
    expect(parseResults(html)).toHaveLength(0);
  });

  it("skips articles with a javascript: href", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="javascript:void(0)">JS link</a></h3>
      </article>
    `);
    expect(parseResults(html)).toHaveLength(0);
  });

  it("ignores engine spans whose text is only whitespace", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="https://example.com">Title</a></h3>
        <div class="engines"><span>   </span><span>brave</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.engines).toEqual(["brave"]);
  });

  it("parses multiple articles in order", () => {
    const html = page(`
      <article class="result result-default">
        <h3><a href="https://a.example.com">A</a></h3>
      </article>
      <article class="result result-default">
        <h3><a href="https://b.example.com">B</a></h3>
      </article>
    `);
    const results = parseResults(html);
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://a.example.com");
    expect(results[1].url).toBe("https://b.example.com");
  });
});
