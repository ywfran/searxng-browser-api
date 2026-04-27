import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — news (category-news)", () => {
  it("extracts all news-specific fields", () => {
    const html = page(`
      <article class="result result-default category-news">
        <a class="thumbnail_link" href="#"><img class="thumbnail" src="https://cdn.example.com/thumb.jpg"></a>
        <h3><a href="https://news.example.com/story">Breaking Story</a></h3>
        <p class="content">Article summary here.</p>
        <time class="published_date" datetime="2024-01-15T10:30:00Z">January 15, 2024</time>
        <div class="highlight">2 hours ago | Reuters</div>
        <div class="engines"><span>google news</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("news");
    expect(r.url).toBe("https://news.example.com/story");
    expect(r.title).toBe("Breaking Story");
    expect(r.content).toBe("Article summary here.");
    expect(r.thumbnail).toBe("https://cdn.example.com/thumb.jpg");
    expect(r.publishedDate).toBe("2024-01-15T10:30:00Z");
    expect(r.source).toBe("Reuters");
    expect(r.engines).toEqual(["google news"]);
  });

  it("falls back to visible text when datetime attribute is absent", () => {
    const html = page(`
      <article class="result result-default category-news">
        <h3><a href="https://news.example.com/story">Story</a></h3>
        <time class="published_date">January 15, 2024</time>
        <div class="highlight">yesterday | BBC</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.publishedDate).toBe("January 15, 2024");
  });

  it("returns undefined source when highlight contains no pipe separator", () => {
    const html = page(`
      <article class="result result-default category-news">
        <h3><a href="https://news.example.com/story">Story</a></h3>
        <div class="highlight">yesterday</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.source).toBeUndefined();
  });

  it("takes the last segment when highlight contains multiple pipes", () => {
    const html = page(`
      <article class="result result-default category-news">
        <h3><a href="https://news.example.com/story">Story</a></h3>
        <div class="highlight">3 days | ago | The Guardian</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.source).toBe("The Guardian");
  });

  it("returns undefined for all optional fields when absent", () => {
    const html = page(`
      <article class="result result-default category-news">
        <h3><a href="https://news.example.com/story">Story</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.thumbnail).toBeUndefined();
    expect(r.publishedDate).toBeUndefined();
    expect(r.source).toBeUndefined();
    expect(r.content).toBeUndefined();
  });
});
