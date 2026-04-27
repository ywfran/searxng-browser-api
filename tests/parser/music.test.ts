import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — music (category-music)", () => {
  it("extracts all music-specific fields via category-music CSS class", () => {
    const html = page(`
      <article class="result result-default category-music">
        <a class="url_header" href="https://soundcloud.com/artist/track"></a>
        <h3><a href="https://soundcloud.com/artist/track">Track Name</a></h3>
        <p class="content">Track description.</p>
        <a class="thumbnail_link" href="#">
          <img class="thumbnail" src="https://i1.sndcdn.com/thumb.jpg">
          <span class="thumbnail_length">3:31</span>
        </a>
        <time class="published_date" datetime="2023-06-01T00:00:00Z">June 1, 2023</time>
        <div class="result_views">Plays: 58000</div>
        <div class="result_author">Artist: DJ Example</div>
        <div class="embedded-content">
          <iframe data-src="https://w.soundcloud.com/player/?url=abc"></iframe>
        </div>
        <div class="engines"><span>soundcloud</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("music");
    expect(r.url).toBe("https://soundcloud.com/artist/track");
    expect(r.title).toBe("Track Name");
    expect(r.content).toBe("Track description.");
    expect(r.thumbnail).toBe("https://i1.sndcdn.com/thumb.jpg");
    expect(r.duration).toBe("3:31");
    expect(r.publishedDate).toBe("2023-06-01T00:00:00Z");
    expect(r.viewCount).toBe("58000");
    expect(r.author).toBe("DJ Example");
    expect(r.embedUrl).toBe("https://w.soundcloud.com/player/?url=abc");
    expect(r.engines).toEqual(["soundcloud"]);
  });

  it("dispatches on data-category=music attribute when CSS class is absent", () => {
    const html = page(`
      <article class="result result-default" data-category="music">
        <h3><a href="https://genius.com/song">Song Title</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("music");
  });

  it("falls back to div.result_length for wikicommons.audio duration format", () => {
    const html = page(`
      <article class="result result-default category-music">
        <h3><a href="https://commons.wikimedia.org/audio/track">Audio Track</a></h3>
        <div class="result_length">Duration: 4:22</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.duration).toBe("4:22");
  });

  it("prefers thumbnail badge over div.result_length when both are present", () => {
    const html = page(`
      <article class="result result-default category-music">
        <h3><a href="https://soundcloud.com/t">Track</a></h3>
        <span class="thumbnail_length">3:00</span>
        <div class="result_length">Duration: 3:00</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.duration).toBe("3:00");
  });

  it("strips locale label prefix from viewCount and author", () => {
    const html = page(`
      <article class="result result-default category-music">
        <h3><a href="https://soundcloud.com/t">Track</a></h3>
        <div class="result_views">Ouvintes: 120K</div>
        <div class="result_author">Artista: Nome Artístico</div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.viewCount).toBe("120K");
    expect(r.author).toBe("Nome Artístico");
  });

  it("returns undefined for optional fields when absent", () => {
    const html = page(`
      <article class="result result-default category-music">
        <h3><a href="https://soundcloud.com/t">Track</a></h3>
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
