import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — videos (result-videos)", () => {
  it("extracts all video-specific fields", () => {
    const html = page(`
      <article class="result result-videos">
        <a class="url_header" href="https://youtube.com/watch?v=abc123"></a>
        <h3><a href="https://youtube.com/watch?v=abc123">Tutorial Video</a></h3>
        <p class="content">Learn about X in this video.</p>
        <a class="thumbnail_link" href="#">
          <img class="thumbnail" src="https://i.ytimg.com/thumb.jpg">
          <span class="thumbnail_length">1:23:45</span>
        </a>
        <time class="published_date" datetime="2024-03-10T00:00:00Z">March 10, 2024</time>
        <div class="result_views">Views: 42000</div>
        <div class="result_author">Author: Tech Channel</div>
        <div class="embedded-video">
          <iframe data-src="https://www.youtube-nocookie.com/embed/abc123"></iframe>
        </div>
        <div class="engines"><span>youtube</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("videos");
    expect(r.url).toBe("https://youtube.com/watch?v=abc123");
    expect(r.title).toBe("Tutorial Video");
    expect(r.content).toBe("Learn about X in this video.");
    expect(r.thumbnail).toBe("https://i.ytimg.com/thumb.jpg");
    expect(r.duration).toBe("1:23:45");
    expect(r.publishedDate).toBe("2024-03-10T00:00:00Z");
    expect(r.viewCount).toBe("42000");
    expect(r.author).toBe("Tech Channel");
    expect(r.embedUrl).toBe("https://www.youtube-nocookie.com/embed/abc123");
    expect(r.engines).toEqual(["youtube"]);
  });

  it("falls back to div.result_length when thumbnail badge is absent", () => {
    const html = page(`
      <article class="result result-videos">
        <h3><a href="https://vimeo.com/123">Clip</a></h3>
        <div class="result_length">Duration: 0:07:30</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.duration).toBe("0:07:30");
  });

  it("prefers thumbnail badge over div.result_length when both are present", () => {
    const html = page(`
      <article class="result result-videos">
        <h3><a href="https://vimeo.com/123">Clip</a></h3>
        <span class="thumbnail_length">5:00</span>
        <div class="result_length">Duration: 0:05:00</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.duration).toBe("5:00");
  });

  it("falls back to h3 a href when url_header anchor is absent", () => {
    const html = page(`
      <article class="result result-videos">
        <h3><a href="https://vimeo.com/456">Vimeo Video</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.url).toBe("https://vimeo.com/456");
  });

  it("strips locale label prefix from viewCount and author", () => {
    const html = page(`
      <article class="result result-videos">
        <h3><a href="https://youtube.com/watch?v=x">Video</a></h3>
        <div class="result_views">Visualizações: 1.2M</div>
        <div class="result_author">Autor: causaoperaria</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.viewCount).toBe("1.2M");
    expect(r.author).toBe("causaoperaria");
  });

  it("falls back to visible text when datetime attribute is absent", () => {
    const html = page(`
      <article class="result result-videos">
        <h3><a href="https://youtube.com/watch?v=x">Video</a></h3>
        <time class="published_date">2 years ago</time>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.publishedDate).toBe("2 years ago");
  });

  it("returns undefined for all optional fields when absent", () => {
    const html = page(`
      <article class="result result-videos">
        <h3><a href="https://youtube.com/watch?v=x">Video</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.duration).toBeUndefined();
    expect(r.publishedDate).toBeUndefined();
    expect(r.viewCount).toBeUndefined();
    expect(r.author).toBeUndefined();
    expect(r.embedUrl).toBeUndefined();
    expect(r.thumbnail).toBeUndefined();
  });
});
