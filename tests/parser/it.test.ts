import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — IT packages (result-packages / category-it)", () => {
  it("extracts all IT package fields from a result-packages article", () => {
    const html = page(`
      <article class="result result-packages category-it">
        <a class="url_header" href="https://hub.docker.com/_/nginx"></a>
        <h3><a href="https://hub.docker.com/_/nginx">nginx</a></h3>
        <p class="content">Official nginx Docker image.</p>
        <div class="attributes">
          <div class="result_package_name"><span>Package:</span><code>library/nginx</code></div>
          <div class="result_maintainer"><span>Maintainer:</span><span>Docker Official</span></div>
          <div class="result_pubdate">
            <span>Updated:</span>
            <time datetime="2024-04-01T00:00:00Z">2024-04-01</time>
          </div>
          <div class="result_tags"><span>Tags:</span><span>web, http, server</span></div>
          <div class="result_popularity"><span>Popularity:</span><span>1B+ pulls</span></div>
          <div class="result_license"><span>License:</span><span>BSD 2-Clause</span></div>
        </div>
        <div class="engines"><span>docker hub</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("it");
    expect(r.url).toBe("https://hub.docker.com/_/nginx");
    expect(r.title).toBe("nginx");
    expect(r.content).toBe("Official nginx Docker image.");
    expect(r.packageName).toBe("library/nginx");
    expect(r.author).toBe("Docker Official");
    expect(r.publishedDate).toBe("2024-04-01T00:00:00Z");
    expect(r.tags).toBe("web, http, server");
    expect(r.popularity).toBe("1B+ pulls");
    expect(r.license).toBe("BSD 2-Clause");
    expect(r.engines).toEqual(["docker hub"]);
  });

  it("forces category to 'it' even when result is dispatched via category-it class", () => {
    const html = page(`
      <article class="result result-default category-it">
        <h3><a href="https://github.com/org/repo">Repo</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("it");
  });

  it("falls back to time element visible text when datetime attribute is absent", () => {
    const html = page(`
      <article class="result result-packages category-it">
        <h3><a href="https://pypi.org/project/requests">requests</a></h3>
        <div class="attributes">
          <div class="result_pubdate"><span>Released:</span><time>January 2024</time></div>
        </div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.publishedDate).toBe("January 2024");
  });

  it("returns undefined for optional fields when absent", () => {
    const html = page(`
      <article class="result result-packages category-it">
        <h3><a href="https://pypi.org/project/requests">requests</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.packageName).toBeUndefined();
    expect(r.author).toBeUndefined();
    expect(r.publishedDate).toBeUndefined();
    expect(r.tags).toBeUndefined();
    expect(r.popularity).toBeUndefined();
    expect(r.license).toBeUndefined();
  });
});
