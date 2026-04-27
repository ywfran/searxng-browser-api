import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — files (result-torrent)", () => {
  it("extracts all torrent-specific fields", () => {
    const html = page(`
      <article class="result result-torrent">
        <a class="url_header" href="https://1337x.to/torrent/123/title/"></a>
        <h3><a href="https://1337x.to/torrent/123/title/">Ubuntu 22.04 LTS</a></h3>
        <a class="magnetlink" href="magnet:?xt=urn:btih:abc123&dn=Ubuntu">Magnet</a>
        <time class="published_date" datetime="2022-04-22T00:00:00Z">April 22, 2022</time>
        <p class="stat">
          <span class="badge">150 Seeders</span>
          <span class="badge">12 Leechers</span>
        </p>
        <p class="stat"><span class="badge">1.23GB File size</span></p>
        <div class="engines"><span>1337x</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("files");
    expect(r.url).toBe("https://1337x.to/torrent/123/title/");
    expect(r.title).toBe("Ubuntu 22.04 LTS");
    expect(r.magnetLink).toBe("magnet:?xt=urn:btih:abc123&dn=Ubuntu");
    expect(r.publishedDate).toBe("2022-04-22T00:00:00Z");
    expect(r.seeders).toBe(150);
    expect(r.leechers).toBe(12);
    expect(r.fileSize).toBe("1.23GB");
    expect(r.engines).toEqual(["1337x"]);
  });

  it("returns null for seeders and leechers when badges show N/A", () => {
    const html = page(`
      <article class="result result-torrent">
        <h3><a href="https://torrent.example.com/file">File</a></h3>
        <p class="stat">
          <span class="badge">N/A Seeders</span>
          <span class="badge">N/A Leechers</span>
        </p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.seeders).toBeNull();
    expect(r.leechers).toBeNull();
  });

  it("strips locale-specific suffix from file size", () => {
    const html = page(`
      <article class="result result-torrent">
        <h3><a href="https://torrent.example.com/file">File</a></h3>
        <p class="stat"></p>
        <p class="stat"><span class="badge">237.46MB Tamanho do arquivo</span></p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.fileSize).toBe("237.46MB");
  });

  it("handles GiB and KiB units in file size", () => {
    const html = page(`
      <article class="result result-torrent">
        <h3><a href="https://torrent.example.com/file">File</a></h3>
        <p class="stat"></p>
        <p class="stat"><span class="badge">4.20GiB Some label</span></p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.fileSize).toBe("4.20GiB");
  });

  it("falls back to visible text when datetime attribute is absent", () => {
    const html = page(`
      <article class="result result-torrent">
        <h3><a href="https://torrent.example.com/file">File</a></h3>
        <time class="published_date">2022</time>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.publishedDate).toBe("2022");
  });

  it("returns undefined for optional fields when absent", () => {
    const html = page(`
      <article class="result result-torrent">
        <h3><a href="https://torrent.example.com/file">File</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.magnetLink).toBeUndefined();
    expect(r.publishedDate).toBeUndefined();
    expect(r.fileSize).toBeUndefined();
    expect(r.seeders).toBeUndefined();
    expect(r.leechers).toBeUndefined();
  });
});
