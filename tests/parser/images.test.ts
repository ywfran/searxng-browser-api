import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — images (result-images)", () => {
  it("extracts all image-specific fields", () => {
    const html = page(`
      <article class="result result-images">
        <a rel="noreferrer" href="https://example.com/image.jpg">
          <img class="image_thumbnail" src="https://proxy.instance/thumb.jpg">
        </a>
        <span class="title">Mountain Landscape</span>
        <p class="result-url"><a href="https://example.com/photos">Source Page</a></p>
        <span class="image_resolution">1920 x 1080</span>
        <p class="result-format"><span>Format:</span>jpeg</p>
        <p class="result-filesize"><span>File size:</span>125.78 KB</p>
        <p class="result-engine"><span>Engine:</span>bing images</p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("images");
    expect(r.imageUrl).toBe("https://example.com/image.jpg");
    expect(r.url).toBe("https://example.com/photos");
    expect(r.title).toBe("Mountain Landscape");
    expect(r.thumbnail).toBe("https://proxy.instance/thumb.jpg");
    expect(r.resolution).toBe("1920 x 1080");
    expect(r.format).toBe("jpeg");
    expect(r.fileSize).toBe("125.78 KB");
    expect(r.engines).toEqual(["bing images"]);
  });

  it("uses imageUrl as the canonical url when no source page link is present", () => {
    const html = page(`
      <article class="result result-images">
        <a rel="noreferrer" href="https://example.com/photo.png"></a>
        <span class="title">Photo</span>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.url).toBe("https://example.com/photo.png");
    expect(r.imageUrl).toBe("https://example.com/photo.png");
  });

  it("falls back to data-src for lazy-loaded thumbnails", () => {
    const html = page(`
      <article class="result result-images">
        <a rel="noreferrer" href="https://example.com/image.jpg">
          <img class="image_thumbnail" data-src="https://proxy.instance/lazy-thumb.jpg">
        </a>
        <span class="title">Photo</span>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.thumbnail).toBe("https://proxy.instance/lazy-thumb.jpg");
  });

  it("omits content when it matches the title exactly", () => {
    const html = page(`
      <article class="result result-images">
        <a rel="noreferrer" href="https://example.com/image.jpg"></a>
        <span class="title">My Photo</span>
        <p class="result-content">My Photo</p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.content).toBeUndefined();
  });

  it("includes content when it differs from the title", () => {
    const html = page(`
      <article class="result result-images">
        <a rel="noreferrer" href="https://example.com/image.jpg"></a>
        <span class="title">My Photo</span>
        <p class="result-content">A beautiful landscape photograph.</p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.content).toBe("A beautiful landscape photograph.");
  });

  it("skips articles with a fragment or missing image url", () => {
    const html = page(`
      <article class="result result-images">
        <a rel="noreferrer" href="#anchor"></a>
      </article>
    `);
    expect(parseResults(html)).toHaveLength(0);
  });

  it("returns undefined for optional fields when absent", () => {
    const html = page(`
      <article class="result result-images">
        <a rel="noreferrer" href="https://example.com/image.jpg"></a>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.resolution).toBeUndefined();
    expect(r.format).toBeUndefined();
    expect(r.fileSize).toBeUndefined();
    expect(r.thumbnail).toBeUndefined();
    expect(r.engines).toBeUndefined();
  });
});
